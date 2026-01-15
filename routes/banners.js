const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');

// GET /api/banners - Get all banners
router.get('/', async (req, res) => {
    try {
        const banners = await req.db.collection('banners').find({}).toArray();
        res.json(banners);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// POST /api/banners - Create a new banner
router.post('/', async (req, res) => {
    try {
        const { image, title, subtitle, tagText, bgColor, accentColor, params } = req.body;

        if (!image || !title) {
            return res.status(400).json({ message: "Image and Title are required" });
        }

        const newBanner = {
            image,
            title,
            subtitle: subtitle || '',
            tagText: tagText || 'New',
            bgColor: bgColor || '#FFFFFF',
            accentColor: accentColor || '#000000',
            params: params || {},
            isActive: true, // Default active
            createdAt: new Date()
        };

        const result = await req.db.collection('banners').insertOne(newBanner);
        res.status(201).json({ ...newBanner, _id: result.insertedId });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// DELETE /api/banners/:id - Delete a banner
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await req.db.collection('banners').deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount === 0) {
            return res.status(404).json({ message: "Banner not found" });
        }

        res.json({ message: "Banner deleted successfully" });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
