const { MongoClient, ObjectId } = require('mongodb');
const uri = 'mongodb+srv://xopunmart_db:xopunmart%2678@xopunmart.yrljy48.mongodb.net/xopunmart?appName=xopunmart';

async function run() {
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db('xopunmart');

    // 1. Remove the test transactions we added
    await db.collection('transactions').deleteMany({
        description: 'System Test Delivery Earnings'
    });

    // 2. Find all riders
    const riders = await db.collection('users').find({ role: 'rider' }).toArray();

    for (const rider of riders) {
        // 3. Find all completed orders for this rider
        const completedOrders = await db.collection('orders').find({
            riderId: { $in: [rider._id.toString(), rider.firebaseUid] },
            status: 'completed'
        }).toArray();

        let realEarnings = 0;

        for (const order of completedOrders) {
            const earning = typeof order.riderEarning === 'number' ? order.riderEarning : 15;
            realEarnings += earning;

            // Ensure there is a transaction for this order
            const orderIdStr = order._id.toString();
            // Since we didn't add transactions before, let's just make sure there's none before inserting
            // Or if we delete all and re-insert? Let's just create transactions for missing ones.
            const existingTx = await db.collection('transactions').findOne({
                userId: rider._id,
                orderId: orderIdStr,
                type: 'credit'
            });

            if (!existingTx) {
                await db.collection('transactions').insertOne({
                    userId: rider._id,
                    type: 'credit',
                    amount: earning,
                    description: `Delivery Earnings #${orderIdStr.substring(orderIdStr.length - 6).toUpperCase()}`,
                    orderId: orderIdStr,
                    createdAt: order.updatedAt || new Date() // Fallback to now if no updatedAt
                });
            }
        }

        // Deduct withdrawals
        const withdrawals = await db.collection('transactions').find({
            userId: rider._id,
            type: 'debit',
            status: { $in: ['pending', 'processed'] }
        }).toArray();

        let totalWithdrawals = 0;
        withdrawals.forEach(w => totalWithdrawals += (w.amount || 0));

        const finalBalance = realEarnings - totalWithdrawals;

        // 4. Update the rider's walletBalance
        await db.collection('users').updateOne(
            { _id: rider._id },
            { $set: { walletBalance: finalBalance } }
        );
        console.log(`Updated rider ${rider.name} (${rider.email}) balance to ${finalBalance}`);
    }

    console.log('Done recalculating balances.');
    await client.close();
}

run().catch(console.dir);
