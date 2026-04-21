const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const admin = require('../firebase');

const JWT_SECRET = process.env.JWT_SECRET || 'xopunmart_secret_key_123';

const { authenticateToken } = require('../middleware/auth');

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

        console.log(`[Notifications] userId=${req.user.id} found=${notifications.length} records`);
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

// POST /api/notifications/subscribe
router.post('/subscribe', authenticateToken, async (req, res) => {
    try {
        const { token, topic } = req.body;
        if (!token || !topic) {
            return res.status(400).json({ message: "Token and topic required" });
        }

        await admin.messaging().subscribeToTopic(token, topic);
        console.log(`Subscribed ${token.substring(0, 10)}... to ${topic}`);

        res.json({ success: true, message: `Subscribed to ${topic}` });
    } catch (error) {
        console.error("Error subscribing to topic:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// POST /api/notifications/admin/push
// Send manual push notification to a topic (Admin)
router.post('/admin/push', authenticateToken, async (req, res) => {
    try {
        const { title, message, targetType, topicName } = req.body;

        if (!title || !message || !topicName) {
            return res.status(400).json({ message: "Missing required fields" });
        }

        const payload = {
            notification: {
                title: title,
                body: message
            },
            data: {
                type: 'admin_broadcast',
                click_action: 'FLUTTER_NOTIFICATION_CLICK'
            },
            topic: topicName
        };

        // Send a message to devices subscribed to the provided topic.
        const response = await admin.messaging().send(payload);

        // Optionally save to generic notifications (or broadcast history) 
        // if we want to track admin sends.
        await req.db.collection('notifications').insertOne({
            title,
            message,
            topic: topicName,
            type: 'broadcast',
            sentBy: req.user.id,
            createdAt: new Date(),
            fcmMessageId: response
        });

        res.json({ success: true, message: `Notification sent to ${topicName}`, response });
    } catch (error) {
        console.error("Error sending admin push:", error);
        res.status(500).json({ message: "Failed to send notification", error: error.message });
    }
});

module.exports = router;
