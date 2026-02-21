require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;
const uri = process.env.MONGO_URI;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

if (!uri) {
    console.error("Error: MONGO_URI is not defined in .env file");
    process.exit(1);
}

const client = new MongoClient(uri);

async function connectDB() {
    try {
        await client.connect();
        console.log("Connected to MongoDB!");
    } catch (error) {
        console.error("Error connecting to MongoDB:", error);
    }
}

connectDB();

// Routes
const productsRoutes = require('./routes/products');
const categoriesRoutes = require('./routes/categories');
const authRoutes = require('./routes/auth');
const seedRoutes = require('./routes/admin_seed');

// Pass db client to routes via middleware or direct injection
// For simplicity here, we'll attach the db instance to the req
app.use(async (req, res, next) => {
    req.db = client.db('xopunmart'); // Using 'xopunmart' as db name
    next();
});

app.use('/api/products', productsRoutes);
app.use('/api/categories', categoriesRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/seed', seedRoutes);
app.use('/api/orders', require('./routes/orders'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/vendors', require('./routes/vendors'));
app.use('/api/riders', require('./routes/riders'));
app.use('/api/users', require('./routes/users'));
app.use('/api/cart', require('./routes/cart'));
app.use('/api/upload', require('./routes/upload'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/banners', require('./routes/banners'));
app.use('/api/coupons', require('./routes/coupons'));
app.use('/api/wishlist', require('./routes/wishlist'));

app.get('/', (req, res) => {
    res.send('Backend Server is running');
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);

    // Auto-Offline Job
    setInterval(async () => {
        try {
            const db = client.db('xopunmart');
            const threshold = new Date(Date.now() - 2 * 60 * 1000); // 2 minutes ago

            // Find riders who need to go offline so we can sync them to Firestore
            const expiredRiders = await db.collection('users').find({
                role: 'rider',
                isOnline: true,
                lastSeen: { $lt: threshold }
            }).toArray();

            if (expiredRiders.length > 0) {
                const expiredIds = expiredRiders.map(r => r._id);

                // Update MongoDB
                await db.collection('users').updateMany(
                    { _id: { $in: expiredIds } },
                    {
                        $set: {
                            isOnline: false,
                            status: 'offline',
                            isAvailable: false
                        }
                    }
                );

                // Sync to Firestore
                const admin = require('./firebase');
                for (const rider of expiredRiders) {
                    if (rider.firebaseUid) {
                        try {
                            await admin.firestore().collection('users').doc(rider.firebaseUid).set({
                                isOnline: false,
                                updatedAt: admin.firestore.FieldValue.serverTimestamp()
                            }, { merge: true });
                        } catch (err) {
                            console.error(`Failed to sync auto-offline to Firestore for ${rider.firebaseUid}:`, err);
                        }
                    }
                }

                console.log(`Auto-offline: Marked ${expiredRiders.length} riders offline.`);
            }
        } catch (e) {
            console.error("Auto-offline job error:", e);
        }
    }, 60 * 1000); // Run every minute
});
