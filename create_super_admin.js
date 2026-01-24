
require('dotenv').config();
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const uri = process.env.MONGO_URI;

if (!uri) {
    console.error("Error: MONGO_URI is not defined in .env file");
    process.exit(1);
}

const client = new MongoClient(uri);

async function createSuperAdmin() {
    try {
        await client.connect();
        console.log("Connected to MongoDB!");

        const db = client.db('xopunmart');
        const usersCollection = db.collection('users');

        const email = 'xopunmart@gmail.com';
        const password = '123456';
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const result = await usersCollection.updateOne(
            { email: email },
            {
                $set: {
                    email: email,
                    password: hashedPassword,
                    role: 'admin', // Using 'admin' as existing roles seem to include 'admin', 'rider', 'vendor', 'user'. 
                    // Assuming 'super admin' capability is either via specific flag or just being *this* admin.
                    // User asked for role "super admin", let's check if the system supports that or if I should use a specific string.
                    // Looking at admin_seed.js it uses 'admin'. 
                    // The user specifically requested 'super admin'. I'll use 'super admin' logic if I can find it, 
                    // otherwise I will stick to the user's request literally: role: 'super admin'.
                    role: 'sysadmin', // Wait, the user asked for "role super admin". 
                    // If the system logic checks for === 'admin', this might break things.
                    // However, I must follow the user's instruction.
                    // Let's look at `backend/routes/auth.js` or middleware to see valid roles if possible?
                    // But for now, I will use "super admin" key as requested, maybe mapped to a 'role' field.
                    // Actually, let's stick to what the user explicitly said: "role super admin".
                    role: 'super admin',
                    name: 'Super Admin',
                    updatedAt: new Date()
                },
                $setOnInsert: { createdAt: new Date() }
            },
            { upsert: true }
        );

        console.log("Super Admin user upserted successfully.");
        console.log("Matched Count:", result.matchedCount);
        console.log("Modified Count:", result.modifiedCount);
        console.log("Upserted Id:", result.upsertedId);

    } catch (error) {
        console.error("Error creating super admin:", error);
    } finally {
        await client.close();
    }
}

createSuperAdmin();
