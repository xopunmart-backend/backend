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

        // 1. Try to find user in MongoDB
        let user;
        if (ObjectId.isValid(userId)) {
            user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
        } else {
            // Assume it is a Firebase UID
            user = await db.collection('users').findOne({ firebaseUid: userId });
        }

        if (user) {
            firebaseUid = user.firebaseUid;
        } else {
            // If not in Mongo, maybe it's passed as direct Firebase UID?
            if (typeof userId === 'string') firebaseUid = userId;
        }

        if (!firebaseUid) {
            console.warn(`Notification skipped: No Firebase UID found for ${userId}`);
            return;
        }

        // 2. Fetch FCM Token from Firestore (Single Source of Truth)
        const userDoc = await admin.firestore().collection('users').doc(firebaseUid).get();
        if (userDoc.exists) {
            fcmToken = userDoc.data().fcmToken;
        }

        // Fallback for Vendors (sometimes needing separate collection)
        if (!fcmToken) {
            const vendorDoc = await admin.firestore().collection('vendors').doc(firebaseUid).get();
            if (vendorDoc.exists) {
                fcmToken = vendorDoc.data().fcmToken;
            }
        }

        if (!fcmToken) {
            console.warn(`Notification skipped: No FCM token found for user ${userId} (UID: ${firebaseUid})`);
            return;
        }

        // 3. Send Notification
        await admin.messaging().send({
            token: fcmToken,
            notification: {
                title: title,
                body: body,
            },
            data: {
                ...data,
                click_action: 'FLUTTER_NOTIFICATION_CLICK' // Standard for Flutter
            }
        });

        console.log(`Notification sent to ${userId}: ${title}`);

        // 4. Save to MongoDB Notifications History (Optional but good)
        if (user && user._id) {
            await db.collection('notifications').insertOne({
                userId: user._id,
                title,
                message: body,
                type: data.type || 'info',
                isRead: false,
                createdAt: new Date()
            });
        }

    } catch (error) {
        console.error("Error sending notification:", error);
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
