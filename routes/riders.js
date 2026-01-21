const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');

// GET /api/riders
router.get('/', async (req, res) => {
    try {
        const riders = await req.db.collection('users')
            .find({ role: 'rider' })
            .project({ password: 0 }) // Exclude password
            .toArray();
        res.json(riders);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});



// GET /api/riders/:id
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid Rider ID" });
        }
        const rider = await req.db.collection('users').findOne(
            { _id: new ObjectId(id), role: 'rider' },
            { projection: { password: 0 } }
        );

        if (!rider) {
            return res.status(404).json({ message: "Rider not found" });
        }

        res.json(rider);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});
router.patch('/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status, firebaseUid } = req.body;

        if (!status) {
            return res.status(400).json({ message: "Status is required" });
        }

        const updates = {
            status: status,
            updatedAt: new Date()
        };

        // Map status to boolean isOnline
        if (status === 'online') updates.isOnline = true;
        if (status === 'offline') updates.isOnline = false;

        // Save Firebase UID if provided (Linkage Step)
        if (firebaseUid) {
            updates.firebaseUid = firebaseUid;
        }

        const result = await req.db.collection('users').updateOne(
            { _id: new ObjectId(id) },
            { $set: updates }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ message: "Rider not found" });
        }

        res.json({ message: "Rider status updated", status });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// PATCH /api/riders/:id/location
router.patch('/:id/location', async (req, res) => {
    try {
        const { id } = req.params;
        const { latitude, longitude } = req.body;

        if (!latitude || !longitude) {
            return res.status(400).json({ message: "Latitude and Longitude are required" });
        }

        const result = await req.db.collection('users').updateOne(
            { _id: new ObjectId(id) },
            {
                $set: {
                    liveLocation: {
                        latitude: parseFloat(latitude),
                        longitude: parseFloat(longitude),
                        updatedAt: new Date()
                    }
                }
            }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ message: "Rider not found" });
        }

        res.json({ message: "Location updated" });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// POST /api/riders/:id/heartbeat
router.post('/:id/heartbeat', async (req, res) => {
    try {
        const { id } = req.params;

        await req.db.collection('users').updateOne(
            { _id: new ObjectId(id) },
            {
                $set: {
                    lastSeen: new Date(),
                    isOnline: true // Ensure they stay marked as online
                }
            }
        );
        res.status(200).send();
    } catch (error) {
        // Silent fail for heartbeat usually
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
