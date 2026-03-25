const admin = require('./firebase');

async function fixCancelledOrders() {
    try {
        console.log("Looking for cancelled orders stuck in searching status...");
        const snapshot = await admin.firestore().collection('orders')
            .where('status', '==', 'cancelled')
            .where('assignmentStatus', '==', 'searching')
            .get();

        if (snapshot.empty) {
            console.log("No stuck cancelled orders found.");
            return;
        }

        console.log(`Found ${snapshot.size} stuck orders. Fixing...`);
        const batch = admin.firestore().batch();
        
        snapshot.docs.forEach(doc => {
            const ref = admin.firestore().collection('orders').doc(doc.id);
            batch.update(ref, {
                assignmentStatus: 'cancelled',
                visibleToRiderId: null
            });
            console.log(`- Fixed order ${doc.id}`);
        });

        await batch.commit();
        console.log("Successfully fixed all stuck orders!");
    } catch (error) {
        console.error("Error:", error);
    }
}

fixCancelledOrders();
