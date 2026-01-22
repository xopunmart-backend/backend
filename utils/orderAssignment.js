const { ObjectId } = require('mongodb');
const admin = require('../firebase');
const { calculateDistance } = require('../utils/geo');

/**
 * Assigns a specific order to the nearest available rider.
 * @param {Db} db - Mongo Database instance
 * @param {ObjectId} orderId - Order ID to assign
 * @param {Object} vendorLocation - { latitude, longitude }
 * @param {Array} excludedRiderIds - List of rider IDs to skip (e.g. rejected)
 */
async function assignOrderToNearestRider(db, orderId, vendorLocation, excludedRiderIds = []) {
    try {
        console.log(`Finding rider for order ${orderId} near`, vendorLocation);

        // 1. Find all online and available riders
        const riders = await db.collection('users').find({
            role: 'rider',
            isOnline: true,
            isAvailable: true,
            _id: { $nin: excludedRiderIds.map(id => new ObjectId(id)) }
        }).toArray();

        // 2. Filter riders with valid location
        const validRiders = riders.filter(r => r.liveLocation && r.liveLocation.latitude && r.liveLocation.longitude);

        if (validRiders.length === 0) {
            console.log("No available riders found.");
            // Reset visibleToRiderId if previously set, or keep null
            await db.collection('orders').updateOne(
                { _id: new ObjectId(orderId) },
                {
                    $set: {
                        visibleToRiderId: null,
                        status: 'pending', // Revert to pending
                        assignmentStatus: 'no_riders_available',
                        updatedAt: new Date()
                    }
                }
            );
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
        // CRITICAL: Prefer Firebase UID for Firestore Rules compatibility.
        // Fallback to MongoID if firebaseUid not set (but rules will fail).
        const assignedId = nearestRider.firebaseUid || nearestRider._id.toString();

        const updateDoc = {
            visibleToRiderId: assignedId,
            status: 'requesting_rider',
            assignmentStatus: 'assigned',
            updatedAt: new Date()
        };

        await db.collection('orders').updateOne(
            { _id: new ObjectId(orderId) },
            { $set: updateDoc }
        );

        // SYNC TO FIRESTORE
        try {
            await admin.firestore().collection('orders').doc(orderId.toString()).update({
                visibleToRiderId: assignedId,
                status: 'requesting_rider',
                assignmentStatus: 'assigned',
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log("Synced assignment to Firestore:", orderId.toString());
        } catch (fsError) {
            console.error("Firestore Sync Error (Assign):", fsError);
        }

        console.log(`Assigned order ${orderId} to rider ${nearestRider._id} (${nearestRider.name}) at ${nearestRider.distance}m`);

        // Send FCM notification to rider
        try {
            let riderToken = null;
            // Rider App saves to 'riders' collection in Firestore
            const riderDoc = await admin.firestore().collection('riders').doc(assignedId).get();
            if (riderDoc.exists) {
                riderToken = riderDoc.data().fcmToken;
            }

            if (riderToken) {
                const message = {
                    notification: {
                        title: "New Delivery Assigned",
                        body: "You have been assigned a new order."
                    },
                    data: {
                        type: "order_assigned",
                        orderId: orderId.toString()
                    },
                    token: riderToken
                };
                await admin.messaging().send(message);
                console.log(`[FCM] Sent assignment notification to rider ${assignedId}`);
            } else {
                console.log(`[FCM] Rider ${assignedId} has no fcmToken in Firestore (riders).`);
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
 * Checks for all pending orders and attempts to assign them.
 * Useful when a rider comes online.
 * @param {Db} db - Mongo Database instance
 */
async function checkAndAssignPendingOrders(db) {
    try {
        console.log("Checking for pending orders to assign...");
        // Find orders that are waiting for assignment
        const pendingOrders = await db.collection('orders').find({
            status: { $in: ['pending', 'preparing', 'ready'] },
            riderId: null,
            visibleToRiderId: null // Not currently offered to anyone
        }).toArray();

        console.log(`Found ${pendingOrders.length} pending orders.`);

        for (const order of pendingOrders) {
            if (order.vendorLocation) {
                // Determine excluded riders (rejected)
                const excluded = order.rejectedByRiders || [];
                // Run assignment (await loop to not overwhelm check, though parallel is okay too)
                await assignOrderToNearestRider(db, order._id, order.vendorLocation, excluded);
            }
        }
    } catch (error) {
        console.error("Check Pending Orders Error:", error);
    }
}

module.exports = {
    assignOrderToNearestRider,
    checkAndAssignPendingOrders
};
