const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const { checkAndAssignPendingOrders } = require('../utils/orderAssignment');

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

        // If going online, trigger assignment for pending orders
        if (status === 'online') {
            // Run asynchronously
            checkAndAssignPendingOrders(req.db);
        }

        // SYNC TO FIRESTORE
        if (result.matchedCount > 0 && firebaseUid) {
            try {
                await admin.firestore().collection('users').doc(firebaseUid).set({
                    role: 'rider', // Ensure role
                    isOnline: updates.isOnline ?? false, // Default to false if not set
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
            } catch (e) {
                console.error("Firestore Sync Rider Status Error:", e);
            }
        }

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

        // SYNC TO FIRESTORE
        // We need the firebaseUid to sync to correct doc.
        // Option: Fetch it from Mongo, but that adds latency.
        // Option: Pass it in body?
        // For now, let's look it up quickly or skip.
        // Ideally App sends firebaseUid in headers/body.
        // Let's rely on finding by Mongo ID match in Firestore? No, Firestore keys are UIDs.
        // We really need firebaseUid here.
        // Let's do a quick lookup since we need it.
        try {
            const user = await req.db.collection('users').findOne({ _id: new ObjectId(id) }, { projection: { firebaseUid: 1 } });
            if (user && user.firebaseUid) {
                await admin.firestore().collection('users').doc(user.firebaseUid).update({
                    liveLocation: {
                        latitude: parseFloat(latitude),
                        longitude: parseFloat(longitude)
                    }
                });
            }
        } catch (e) {
            console.error("Firestore Sync Location Error:", e);
        }

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
        const { firebaseUid } = req.body; // Accept linkage

        const updates = {
            lastSeen: new Date(),
            isOnline: true
        };

        if (firebaseUid) {
            updates.firebaseUid = firebaseUid;
        }

        await req.db.collection('users').updateOne(
            { _id: new ObjectId(id) },
            { $set: updates }
        );
        res.status(200).send();
    } catch (error) {
        // Silent fail for heartbeat usually
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
