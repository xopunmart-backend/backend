const admin = require('../firebase');
const { ObjectId } = require('mongodb');

/**
 * Send notification to a specific user (Customer, Vendor, Rider)
 * @param {Db} db - MongoDB database instance
 * @param {string|ObjectId} userId - User's MongoDB ID or Firestore UID
 * @param {string} title - Notification Title
 * @param {string} body - Notification Body
 * @param {Object} data - Additional data payload (optional)
 */
const sendToUser = async (db, userId, title, body, data = {}) => {
    try {
        if (!userId) {
            console.warn("Notification skipped: No userId provided");
            return;
        }

        let fcmToken = null;
        let firebaseUid = null;
        let user = null;

        // 1. Find user in the 'users' collection (ALL roles: customer, vendor, rider are here)
        if (ObjectId.isValid(userId)) {
            user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
        }

        // If not found by ObjectId, try firebaseUid string
        if (!user && typeof userId === 'string') {
            user = await db.collection('users').findOne({ firebaseUid: userId });
        }

        if (user) {
            firebaseUid = user.firebaseUid;
            if (user.fcmToken) {
                fcmToken = user.fcmToken;
            }
        } else {
            if (typeof userId === 'string') firebaseUid = userId;
        }

        // 2. Save to MongoDB Notifications History ALWAYS (so in-app screen always shows it)
        if (user && user._id) {
            try {
                await db.collection('notifications').insertOne({
                    userId: user._id,
                    title,
                    message: body,
                    type: data.type || 'info',
                    isRead: false,
                    createdAt: new Date()
                });
            } catch (dbErr) {
                console.error('Failed to save notification to DB:', dbErr);
            }
        } else {
            console.warn(`Could not save notification to DB: user not found for userId=${userId}`);
        }

        // 3. Try to get FCM token from Firestore if not in MongoDB
        if (!fcmToken && firebaseUid) {
            try {
                const userDoc = await admin.firestore().collection('users').doc(firebaseUid).get();
                if (userDoc.exists) fcmToken = userDoc.data().fcmToken;
            } catch (_) {}
        }
        if (!fcmToken && firebaseUid) {
            try {
                const vendorDoc = await admin.firestore().collection('vendors').doc(firebaseUid).get();
                if (vendorDoc.exists) fcmToken = vendorDoc.data().fcmToken;
            } catch (_) {}
        }
        if (!fcmToken && firebaseUid) {
            try {
                const riderDoc = await admin.firestore().collection('riders').doc(firebaseUid).get();
                if (riderDoc.exists) fcmToken = riderDoc.data().fcmToken;
            } catch (_) {}
        }

        if (!fcmToken) {
            console.warn(`Push skipped: No FCM token for user ${userId}. Saved to in-app history.`);
            return;
        }

        // 4. Send FCM Push Notification
        await admin.messaging().send({
            token: fcmToken,
            notification: { title, body },
            data: {
                ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
                click_action: 'FLUTTER_NOTIFICATION_CLICK'
            }
        });

        console.log(`Push sent to ${userId}: ${title}`);

    } catch (error) {
        console.error(`Error sending notification to user ${userId}:`, error);
        if (error.code === 'messaging/registration-token-not-registered') {
            console.warn(`Token invalid for user ${userId}, consider removing from DB.`);
        }
    }
};


/**
 * Send notification to a topic (e.g., 'admin_notifications')
 * @param {string} topic - Topic name
 * @param {string} title - Notification Title
 * @param {string} body - Notification Body
 * @param {Object} data - Additional data payload (optional)
 */
const sendToTopic = async (topic, title, body, data = {}) => {
    try {
        await admin.messaging().send({
            topic: topic,
            notification: {
                title: title,
                body: body,
            },
            data: {
                ...data,
                click_action: 'FLUTTER_NOTIFICATION_CLICK'
            }
        });
        console.log(`Notification sent to topic ${topic}: ${title}`);
    } catch (error) {
        console.error(`Error sending notification to topic ${topic}:`, error);
    }
};

module.exports = {
    sendToUser,
    sendToTopic
};
