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
        const riderDoc = await req.db.collection('users').findOne({ _id: new ObjectId(id) });

        if (status === 'online') {
            updates.isOnline = true;
            updates.isAvailable = true; // Mark as available for orders

            // Only record when they went online if they weren't already online
            if (!riderDoc || !riderDoc.isOnline) {
                updates.lastOnlineAt = new Date();
            }
        }
        if (status === 'offline') {
            updates.isOnline = false;
            updates.isAvailable = false;

            // Calculate how long they were online and add to today's total
            if (riderDoc && riderDoc.lastOnlineAt && riderDoc.isOnline !== false) {
                const now = new Date();
                const lastOnline = new Date(riderDoc.lastOnlineAt);

                // Only count time if they went online today
                if (now.toDateString() === lastOnline.toDateString()) {
                    const diffMs = now - lastOnline;

                    if (diffMs > 0) {
                        // Check if we already have accumulated ms for today
                        let todayMs = 0;
                        if (riderDoc.onlineSessions && riderDoc.onlineSessions.date === now.toDateString()) {
                            todayMs = riderDoc.onlineSessions.totalMs || 0;
                        }

                        updates.onlineSessions = {
                            date: now.toDateString(),
                            totalMs: todayMs + diffMs
                        };
                    }
                }
            }
        }

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
                    },
                    lastSeen: new Date()
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

// GET /api/riders/:id/analytics
router.get('/:id/analytics', async (req, res) => {
    try {
        const { id } = req.params;
        const db = req.db;

        // Verify rider exists
        const user = await db.collection('users').findOne(
            { _id: new ObjectId(id) },
            { projection: { firebaseUid: 1, role: 1 } }
        );

        if (!user || user.role !== 'rider') {
            return res.status(404).json({ message: "Rider not found" });
        }

        const firebaseUid = user.firebaseUid;
        const riderIdStr = id.toString();

        // Calculate date range (last 7 days including today)
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        const weekStart = new Date(startOfToday);
        weekStart.setDate(weekStart.getDate() - 6); // 7 days total including today

        // Fetch orders from Firestore 
        const snapshot = await admin.firestore().collection('orders')
            .where('status', '==', 'completed')
            .get();

        const dailyStats = [];
        // Initialize daily stats array with 0s for the last 7 days
        for (let i = 6; i >= 0; i--) {
            const date = new Date(startOfToday);
            date.setDate(date.getDate() - i);
            dailyStats.push({
                date: date.toISOString().split('T')[0], // YYYY-MM-DD
                earnings: 0,
                trips: 0
            });
        }

        let thisWeekEarnings = 0;
        let thisWeekTrips = 0;

        snapshot.forEach(doc => {
            const orderData = doc.data();

            // Match rider
            if (orderData.riderId === riderIdStr || orderData.riderId === firebaseUid) {
                const timestamp = orderData.updatedAt || orderData.createdAt;
                if (timestamp) {
                    let date;
                    if (typeof timestamp.toDate === 'function') {
                        date = timestamp.toDate();
                    } else if (timestamp instanceof Date) {
                        date = timestamp;
                    } else if (typeof timestamp === 'string') {
                        date = new Date(timestamp);
                    }

                    // Check if the order falls within our 7-day window
                    if (date && date >= weekStart) {
                        const orderDateStr = date.toISOString().split('T')[0];
                        const statIndex = dailyStats.findIndex(s => s.date === orderDateStr);

                        if (statIndex !== -1) {
                            const earning = parseFloat(orderData.deliveryFee || 15); // Default delivery fee 15 if missing

                            dailyStats[statIndex].earnings += earning;
                            dailyStats[statIndex].trips += 1;

                            thisWeekEarnings += earning;
                            thisWeekTrips += 1;
                        }
                    }
                }
            }
        });

        res.json({
            thisWeekEarnings: thisWeekEarnings,
            thisWeekTrips: thisWeekTrips,
            dailyStats: dailyStats
        });

    } catch (error) {
        console.error("Analytics fetch error:", error);
        res.status(500).json({ message: "Server error fetching analytics" });
    }
});

module.exports = router;
