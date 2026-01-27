const { ObjectId } = require('mongodb');
const admin = require('../firebase');
const { calculateDistance } = require('../utils/geo');

/**
 * Assigns a specific order to the nearest available rider.
 * @param {Db} db - Mongo Database instance (for Riders)
 * @param {string} orderId - Order ID to assign (Firestore Doc ID)
 * @param {Object} vendorLocation - { latitude, longitude }
 * @param {Array} excludedRiderIds - List of rider IDs to skip (e.g. rejected)
 */
/**
 * Assigns (Broadcasts) a specific order to all available riders.
 * Note: Keeps visibleToRiderId as NULL so complete list sees it.
 * @param {Db} db - Mongo Database instance (for Riders)
 * @param {string} orderId - Order ID to assign (Firestore Doc ID)
 * @param {Object} vendorLocation - { latitude, longitude }
 * @param {Array} excludedRiderIds - List of rider IDs to skip (e.g. rejected)
 */
async function assignOrderToNearestRider(db, orderId, vendorLocation, excludedRiderIds = []) {
    try {
        console.log(`Broadcasting order ${orderId} near`, vendorLocation);

        // 1. Find all online and available riders (Keep MongoDB for now as Users are there)
        const riders = await db.collection('users').find({
            role: 'rider',
            isOnline: true,
            isAvailable: true,
            // Exclude rejected riders (Handle both ObjectId and String)
            _id: {
                $nin: excludedRiderIds.map(id => ObjectId.isValid(id) ? new ObjectId(id) : id)
            }
        }).toArray();

        // 2. Filter riders with valid location
        const validRiders = riders.filter(r => r.liveLocation && r.liveLocation.latitude && r.liveLocation.longitude);

        if (validRiders.length === 0) {
            console.log("No available riders found to broadcast.");
            // Mark as 'searching' but visible to 'null' (i.e. everyone who might come online)
            await admin.firestore().collection('orders').doc(orderId.toString()).update({
                visibleToRiderId: null,
                status: 'pending',
                assignmentStatus: 'searching', // Changed from 'no_riders_available' so it shows up in "New Requests" list
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return null;
        }

        // 3. Set Order to 'Requesting' / 'Searching' for ALL
        // Instead of assigning to one, we just ensure it is OPEN.
        await admin.firestore().collection('orders').doc(orderId.toString()).update({
            visibleToRiderId: null, // Open for all
            status: 'requesting_rider',
            assignmentStatus: 'searching',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`Broadcasted order ${orderId} to ${validRiders.length} riders.`);

        // 4. Send FCM notification to ALL found riders
        for (const rider of validRiders) {
            try {
                let riderToken = null;
                const rId = rider.firebaseUid || rider._id.toString();

                // Rider App saves to 'riders' collection in Firestore
                const riderDoc = await admin.firestore().collection('riders').doc(rId).get();
                if (riderDoc.exists) {
                    riderToken = riderDoc.data().fcmToken;
                } else {
                    // Fallback to 'users' collection 
                    const userDoc = await admin.firestore().collection('users').doc(rId).get();
                    if (userDoc.exists) riderToken = userDoc.data().fcmToken;
                }

                if (riderToken) {
                    const message = {
                        notification: {
                            title: "New Order Available",
                            body: "A new order is available for pickup."
                        },
                        data: {
                            type: "order_assigned", // Using same type for now to trigger refresh
                            orderId: orderId.toString()
                        },
                        token: riderToken
                    };
                    await admin.messaging().send(message);
                    // console.log(`[FCM] Sent broadcast to rider ${rId}`);
                }
            } catch (notifErr) {
                console.error(`[FCM] Error notifying rider ${rider.name}:`, notifErr);
            }
        }

        return validRiders;

    } catch (error) {
        console.error("Assignment Error:", error);
    }
}

/**
 * Assigns (Broadcasts) a batch of orders (same groupId) to all available riders.
 * @param {Db} db - Mongo Database instance
 * @param {string} groupId - Shared Group ID
 * @param {Array} batchOrders - Array of { orderId, vendorLocation }
 * @param {Array} excludedRiderIds - List of rider IDs to skip
 */
async function assignOrderBatchToNearestRider(db, groupId, batchOrders, excludedRiderIds = []) {
    try {
        if (!batchOrders || batchOrders.length === 0) return;

        // Use the first location to find a rider (simplification)
        const referenceLocation = batchOrders[0].vendorLocation;
        console.log(`Broadcasting BATCH ${groupId} near`, referenceLocation);

        // 1. Find all online and available riders
        const riders = await db.collection('users').find({
            role: 'rider',
            isOnline: true,
            isAvailable: true,
            _id: {
                $nin: excludedRiderIds.map(id => ObjectId.isValid(id) ? new ObjectId(id) : id)
            }
        }).toArray();

        const validRiders = riders.filter(r => r.liveLocation && r.liveLocation.latitude && r.liveLocation.longitude);

        // 2. Update Firestore Orders to be OPEN
        const batch = admin.firestore().batch();
        for (const item of batchOrders) {
            const ref = admin.firestore().collection('orders').doc(item.orderId);
            batch.update(ref, {
                visibleToRiderId: null, // Broadcast
                status: 'requesting_rider',
                assignmentStatus: 'searching',
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        await batch.commit();

        if (validRiders.length === 0) {
            console.log("No available riders found for batch broadcast.");
            return null;
        }

        console.log(`Broadcasted BATCH ${groupId} to ${validRiders.length} riders.`);

        // 3. Send Notification to ALL found riders
        for (const rider of validRiders) {
            try {
                let riderToken = null;
                const rId = rider.firebaseUid || rider._id.toString();

                const riderDoc = await admin.firestore().collection('riders').doc(rId).get();
                if (riderDoc.exists) riderToken = riderDoc.data().fcmToken;
                else {
                    const userDoc = await admin.firestore().collection('users').doc(rId).get();
                    if (userDoc.exists) riderToken = userDoc.data().fcmToken;
                }

                if (riderToken) {
                    await admin.messaging().send({
                        notification: {
                            title: "New Batch Delivery",
                            body: `Multi-vendor order request available!`
                        },
                        data: {
                            type: "order_assigned",
                            batchId: groupId
                        },
                        token: riderToken
                    });
                }
            } catch (notifErr) {
                console.error(`[FCM] Error notifying rider ${rider.name} for batch:`, notifErr);
            }
        }

        return validRiders;

    } catch (error) {
        console.error("Batch Assignment Error:", error);
    }
}

/**
 * Checks for all pending orders and attempts to assign them.
 * Useful when a rider comes online.
 * @param {Db} db - Mongo Database instance
 */
async function checkAndAssignPendingOrders(db) {
    try {
        console.log("Checking for pending orders to assign...");

        // Find orders that are waiting for assignment in FIRESTORE
        // status IN [pending, preparing, ready] AND riderId == null AND visibleToRiderId == null
        const snapshot = await admin.firestore().collection('orders')
            .where('status', 'in', ['pending', 'preparing', 'ready'])
            .where('riderId', '==', null)
            .where('visibleToRiderId', '==', null)
            .get();

        const pendingOrders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        console.log(`Found ${pendingOrders.length} pending orders.`);

        // Group by groupId for batch assignment, others as single
        const groups = {};
        const singles = [];

        for (const order of pendingOrders) {
            if (order.groupId) {
                if (!groups[order.groupId]) groups[order.groupId] = [];
                groups[order.groupId].push(order);
            } else {
                singles.push(order);
            }
        }

        // Process Singles
        for (const order of singles) {
            if (order.vendorLocation) {
                const excluded = order.rejectedByRiders || [];
                await assignOrderToNearestRider(db, order.id, order.vendorLocation, excluded);
            }
        }

        // Process Groups
        for (const gId in groups) {
            const groupOrders = groups[gId];
            if (groupOrders.length > 0) {
                const batchForAssign = groupOrders.map(o => ({
                    orderId: o.id,
                    vendorLocation: o.vendorLocation
                })).filter(o => o.vendorLocation); // Ensure location exists

                if (batchForAssign.length > 0) {
                    // Use excluded from the first order (assuming they are rejected as a group, 
                    // or we should merge rejected lists. For now, use first order's list)
                    const excluded = groupOrders[0].rejectedByRiders || [];
                    await assignOrderBatchToNearestRider(db, gId, batchForAssign, excluded);
                }
            }
        }

    } catch (error) {
        console.error("Check Pending Orders Error:", error);
    }
}

module.exports = {
    assignOrderToNearestRider,
    assignOrderBatchToNearestRider,
    checkAndAssignPendingOrders
};
