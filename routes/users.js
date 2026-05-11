const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const admin = require('../firebase');

// GET all users (customers)
router.get('/', async (req, res) => {
    try {
        const db = req.db;
        // Fetch both 'user' (email signup) and 'customer' (phone auth) roles
        const users = await db.collection('users').find({ role: { $in: ['user', 'customer'] } }).toArray();
        res.json(users);
    } catch (error) {
        console.error("Error fetching users:", error);
        res.status(500).json({ message: "Failed to fetch users" });
    }
});

// GET top 10 customers by order count & total spending
router.get('/top', async (req, res) => {
    try {
        const db = req.db;

        // 1. Fetch all orders from Firestore
        const snapshot = await admin.firestore().collection('orders').get();

        // 2. Aggregate by userId
        const userMap = {}; // { userId: { orderCount, totalSpent } }
        snapshot.forEach(doc => {
            const order = doc.data();
            const uid = order.userId;
            if (!uid) return;

            if (!userMap[uid]) {
                userMap[uid] = { orderCount: 0, totalSpent: 0 };
            }
            userMap[uid].orderCount += 1;
            userMap[uid].totalSpent += parseFloat(order.totalAmount) || 0;
        });

        // 3. Sort by totalSpent descending, take top 10
        const topEntries = Object.entries(userMap)
            .sort((a, b) => b[1].totalSpent - a[1].totalSpent)
            .slice(0, 10);

        if (topEntries.length === 0) {
            return res.json([]);
        }

        // 4. Enrich with MongoDB user details
        const topUsers = await Promise.all(topEntries.map(async ([userId, stats]) => {
            let userDetails = null;
            try {
                if (ObjectId.isValid(userId)) {
                    userDetails = await db.collection('users').findOne(
                        { _id: new ObjectId(userId) },
                        { projection: { password: 0 } }
                    );
                }
            } catch (e) { /* skip if ID invalid */ }

            return {
                userId,
                name: userDetails?.name || 'Unknown',
                email: userDetails?.email || '',
                phone: userDetails?.phoneNumber || userDetails?.phone || '',
                orderCount: stats.orderCount,
                totalSpent: parseFloat(stats.totalSpent.toFixed(2)),
            };
        }));

        res.json(topUsers);
    } catch (error) {
        console.error("Error fetching top users:", error);
        res.status(500).json({ message: "Failed to fetch top users" });
    }
});

// GET user by ID
router.get('/:id', async (req, res) => {
    try {
        const db = req.db;
        const userId = req.params.id;

        if (!ObjectId.isValid(userId)) {
            return res.status(400).json({ message: "Invalid user ID" });
        }

        const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });

        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        // Exclude sensitive information
        const { password, ...userWithoutPassword } = user;
        res.json(userWithoutPassword);
    } catch (error) {
        console.error("Error fetching user by ID:", error);
        res.status(500).json({ message: "Failed to fetch user details" });
    }
});

// PATCH /api/users/:id (Profile Update)
router.patch('/:id', async (req, res) => {
    try {
        const db = req.db;
        const userId = req.params.id;
        const updates = req.body;

        if (!ObjectId.isValid(userId)) {
            return res.status(400).json({ message: "Invalid user ID" });
        }

        // Filter updates to allow only specific fields
        const allowedUpdates = ['name', 'email', 'profileImage', 'phoneNumber'];
        const filteredUpdates = {};
        Object.keys(updates).forEach(key => {
            if (allowedUpdates.includes(key)) {
                filteredUpdates[key] = updates[key];
            }
        });

        if (Object.keys(filteredUpdates).length === 0) {
            return res.status(400).json({ message: "No valid updates provided" });
        }

        filteredUpdates.updatedAt = new Date();

        const result = await db.collection('users').findOneAndUpdate(
            { _id: new ObjectId(userId) },
            { $set: filteredUpdates },
            { returnDocument: 'after', projection: { password: 0 } }
        );

        if (!result) {
            return res.status(404).json({ message: "User not found" });
        }

        res.json({ message: "Profile updated successfully", user: result });
    } catch (error) {
        console.error("Error updating profile:", error);
        res.status(500).json({ message: "Failed to update profile" });
    }
});

module.exports = router;

