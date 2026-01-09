const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');

// GET /api/vendors
router.get('/', async (req, res) => {
    try {
        const vendors = await req.db.collection('users')
            .find({ role: 'vendor' })
            .project({ password: 0 }) // Exclude password
            .toArray();
        res.json(vendors);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// PATCH /api/vendors/:id/status
router.patch('/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!status) {
            return res.status(400).json({ message: "Status is required" });
        }

        const result = await req.db.collection('users').updateOne(
            { _id: new ObjectId(id) },
            { $set: { status: status, updatedAt: new Date() } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ message: "Vendor not found" });
        }

        res.json({ message: "Vendor status updated", status });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
