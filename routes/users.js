const express = require('express');
const router = express.Router();

// GET all users (customers)
router.get('/', async (req, res) => {
    try {
        const db = req.db;
        // Assuming your users collection is named 'users' and role 'user' identifies customers
        // You might need to adjust the query based on your actual schema (e.g., 'customers' collection)
        const users = await db.collection('users').find({ role: 'user' }).toArray();
        res.json(users);
    } catch (error) {
        console.error("Error fetching users:", error);
        res.status(500).json({ message: "Failed to fetch users" });
    }
});
// GET user by ID
router.get('/:id', async (req, res) => {
    try {
        const { ObjectId } = require('mongodb');
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

module.exports = router;
