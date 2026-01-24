const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const { authenticateToken } = require('../middleware/auth');

// GET /api/coupons
router.get('/', async (req, res) => {
    try {
        const coupons = await req.db.collection('coupons').find().sort({ createdAt: -1 }).toArray();
        res.json(coupons);
    } catch (error) {
        console.error("Error fetching coupons:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// POST /api/coupons
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { code, description, discountType, discountValue, minOrderAmount, expiryDate } = req.body;

        if (!code || !description) {
            return res.status(400).json({ message: "Code and description are required" });
        }

        const newCoupon = {
            code: code.toUpperCase(),
            description,
            discountType: discountType || 'percentage', // percentage, fixed
            discountValue: parseFloat(discountValue) || 0,
            minOrderAmount: parseFloat(minOrderAmount) || 0,
            expiryDate: expiryDate ? new Date(expiryDate) : null,
            isActive: true,
            createdAt: new Date()
        };

        const result = await req.db.collection('coupons').insertOne(newCoupon);
        newCoupon._id = result.insertedId;

        res.json(newCoupon);
    } catch (error) {
        console.error("Error creating coupon:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// PATCH /api/coupons/:id/toggle
router.patch('/:id/toggle', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { isActive } = req.body;

        await req.db.collection('coupons').updateOne(
            { _id: new ObjectId(id) },
            { $set: { isActive } }
        );

        res.json({ message: "Updated successfully" });
    } catch (error) {
        console.error("Error toggling coupon:", error);
        res.status(500).json({ message: "Server error" });
    }
});


// POST /api/coupons/apply
router.post('/apply', authenticateToken, async (req, res) => {
    try {
        const { code, cartTotal } = req.body;

        if (!code) {
            return res.status(400).json({ message: "Coupon code is required" });
        }

        const coupon = await req.db.collection('coupons').findOne({
            code: code.toUpperCase(),
            isActive: true
        });

        if (!coupon) {
            return res.status(404).json({ message: "Invalid or expired coupon" });
        }

        // Check expiry
        if (coupon.expiryDate && new Date(coupon.expiryDate) < new Date()) {
            return res.status(400).json({ message: "Coupon expired" });
        }

        // Check min order amount
        if (coupon.minOrderAmount && cartTotal < coupon.minOrderAmount) {
            return res.status(400).json({
                message: `Minimum order amount of ₹${coupon.minOrderAmount} required`
            });
        }

        // Calculate discount
        let discountAmount = 0;
        if (coupon.discountType === 'percentage') {
            discountAmount = (cartTotal * coupon.discountValue) / 100;
        } else {
            discountAmount = coupon.discountValue;
        }

        // Cap discount if needed (optional logic, not implemented in schema yet)

        // Ensure discount doesn't exceed total
        if (discountAmount > cartTotal) {
            discountAmount = cartTotal;
        }

        res.json({
            success: true,
            couponCode: coupon.code,
            discountAmount: discountAmount,
            message: "Coupon applied successfully"
        });

    } catch (error) {
        console.error("Error applying coupon:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// DELETE /api/coupons/:id
router.delete('/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await req.db.collection('coupons').deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount === 0) {
            return res.status(404).json({ message: "Coupon not found" });
        }

        res.json({ message: "Deleted successfully" });
    } catch (error) {
        console.error("Error deleting coupon:", error);
        res.status(500).json({ message: "Server error" });
    }
});

module.exports = router;
