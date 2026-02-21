const admin = require('./firebase');
async function test() {
    const snapshot = await admin.firestore().collection('orders').orderBy('createdAt', 'desc').limit(1).get();
    if (snapshot.empty) {
        console.log("No orders");
        return;
    }
    const doc = snapshot.docs[0];
    console.log(doc.id, doc.data());
}
test();
