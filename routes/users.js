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

module.exports = router;
