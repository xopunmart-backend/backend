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
async function assignOrderToNearestRider(db, orderId, vendorLocation, excludedRiderIds = []) {
    try {
        console.log(`Finding rider for order ${orderId} near`, vendorLocation);

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
            console.log("No available riders found.");
            // Update Firestore Order directly
            await admin.firestore().collection('orders').doc(orderId.toString()).update({
                visibleToRiderId: null,
                status: 'pending',
                assignmentStatus: 'no_riders_available',
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return null;
        }

        // 3. Calculate distances
        const ridersWithDistance = validRiders.map(rider => ({
            ...rider,
            distance: calculateDistance(vendorLocation, rider.liveLocation)
        }));

        // 4. Sort by distance
        ridersWithDistance.sort((a, b) => a.distance - b.distance);
        const nearestRider = ridersWithDistance[0];

        // 5. Assign
        // Prefer Firebase UID
        const assignedId = nearestRider.firebaseUid || nearestRider._id.toString();

        await admin.firestore().collection('orders').doc(orderId.toString()).update({
            visibleToRiderId: assignedId,
            status: 'requesting_rider',
            assignmentStatus: 'assigned',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`Assigned order ${orderId} to rider ${nearestRider._id} (${nearestRider.name}) at ${nearestRider.distance}m`);

        // Send FCM notification to rider
        try {
            let riderToken = null;
            // Rider App saves to 'riders' collection in Firestore
            const riderDoc = await admin.firestore().collection('riders').doc(assignedId).get();
            if (riderDoc.exists) {
                riderToken = riderDoc.data().fcmToken;
            } else {
                // Fallback to 'users' collection if not in riders
                const userDoc = await admin.firestore().collection('users').doc(assignedId).get();
                if (userDoc.exists) riderToken = userDoc.data().fcmToken;
            }

            if (riderToken) {
                const message = {
                    notification: {
                        title: "New Delivery Assigned",
                        body: "You have been assigned a new order."
                    },
                    data: {
                        type: "order_assigned",
                        orderId: orderId.toString() // Firestore ID is string
                    },
                    token: riderToken
                };
                await admin.messaging().send(message);
                console.log(`[FCM] Sent assignment notification to rider ${assignedId}`);
            } else {
                console.log(`[FCM] Rider ${assignedId} has no fcmToken.`);
            }
        } catch (notifErr) {
            console.error("[FCM] Error sending rider notification:", notifErr);
        }

        return nearestRider;

    } catch (error) {
        console.error("Assignment Error:", error);
    }
}

/**
 * Assigns a batch of orders (same groupId) to the nearest available rider.
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
        console.log(`Finding rider for BATCH ${groupId} near`, referenceLocation);

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

        if (validRiders.length === 0) {
            console.log("No available riders found for batch.");
            // Update Firestore Orders
            const batch = admin.firestore().batch();
            for (const item of batchOrders) {
                const ref = admin.firestore().collection('orders').doc(item.orderId);
                batch.update(ref, {
                    visibleToRiderId: null,
                    status: 'pending',
                    assignmentStatus: 'no_riders_available',
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }
            await batch.commit();
            return null;
        }

        // 2. Calculate distances
        const ridersWithDistance = validRiders.map(rider => ({
            ...rider,
            distance: calculateDistance(referenceLocation, rider.liveLocation)
        }));

        ridersWithDistance.sort((a, b) => a.distance - b.distance);
        const nearestRider = ridersWithDistance[0];

        // 3. Assign
        const assignedId = nearestRider.firebaseUid || nearestRider._id.toString();

        const writeBatch = admin.firestore().batch();
        for (const item of batchOrders) {
            const ref = admin.firestore().collection('orders').doc(item.orderId);
            writeBatch.update(ref, {
                visibleToRiderId: assignedId,
                status: 'requesting_rider',
                assignmentStatus: 'assigned',
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        await writeBatch.commit();

        console.log(`Assigned BATCH ${groupId} to rider ${nearestRider._id} (${nearestRider.name})`);

        // 4. Send Notification (Single notification for the batch)
        try {
            let riderToken = null;
            const riderDoc = await admin.firestore().collection('riders').doc(assignedId).get();
            if (riderDoc.exists) riderToken = riderDoc.data().fcmToken;
            else {
                const userDoc = await admin.firestore().collection('users').doc(assignedId).get();
                if (userDoc.exists) riderToken = userDoc.data().fcmToken;
            }

            if (riderToken) {
                await admin.messaging().send({
                    notification: {
                        title: "New Batch Delivery",
                        body: `You have a multi-vendor order request!`
                    },
                    data: {
                        type: "order_assigned",
                        batchId: groupId // Send batchId so client knows
                    },
                    token: riderToken
                });
            }
        } catch (notifErr) {
            console.error("[FCM] Error sending rider notification:", notifErr);
        }

        return nearestRider;

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
