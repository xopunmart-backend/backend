const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'xopunmart_secret_key_123';

// Middleware to authenticate token
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

// GET /api/notifications
// Fetch notifications for the logged-in user
router.get('/', authenticateToken, async (req, res) => {
    try {
        const userId = new ObjectId(req.user.id);

        // Fetch notifications for this user, sorted by date desc
        const notifications = await req.db.collection('notifications')
            .find({ userId: userId })
            .sort({ createdAt: -1 })
            .limit(50)
            .toArray();

        res.json(notifications);
    } catch (error) {
        console.error("Error fetching notifications:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// POST /api/notifications (Internal/Admin use mainly)
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { title, message, type, userId } = req.body;

        if (!title || !message || !userId) {
            return res.status(400).json({ message: "Missing required fields" });
        }

        const newNotification = {
            userId: new ObjectId(userId),
            title,
            message,
            type: type || 'info', // info, order, alert
            isRead: false,
            createdAt: new Date()
        };

        const result = await req.db.collection('notifications').insertOne(newNotification);

        res.status(201).json({
            success: true,
            id: result.insertedId,
            message: "Notification created"
        });
    } catch (error) {
        console.error("Error creating notification:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = new ObjectId(req.user.id);

        const result = await req.db.collection('notifications').updateOne(
            { _id: new ObjectId(id), userId: userId },
            { $set: { isRead: true } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ message: "Notification not found" });
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ message: "Server error" });
    }
});

module.exports = router;
