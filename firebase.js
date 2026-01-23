const admin = require('firebase-admin');
const dotenv = require('dotenv');

dotenv.config();

try {
    // Option 1: Use service account file if it exists
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    admin.firestore().settings({ ignoreUndefinedProperties: true });
    console.log("Firebase Admin initialized with serviceAccountKey.json");
} catch (error) {
    // Option 2: Fallback to GOOGLE_APPLICATION_CREDENTIALS or default env vars
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        admin.initializeApp({
            credential: admin.credential.applicationDefault()
        });
        admin.firestore().settings({ ignoreUndefinedProperties: true });
        console.log("Firebase Admin initialized with GOOGLE_APPLICATION_CREDENTIALS");
    } else {
        // If no credentials found, initialize anyway (might fail on send) but prevent crash
        console.warn("WARNING: No Firebase credentials found. Push notifications will fail.");
        // admin.initializeApp(); // Uncomment if you want to try default initialization
    }
}

module.exports = admin;
