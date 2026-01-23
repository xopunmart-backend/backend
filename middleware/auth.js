const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'xopunmart_secret_key_123';

const admin = require('../firebase');

const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.sendStatus(401);

    // 1. Try Custom JWT (Legacy/Backend Generated)
    try {
        const user = jwt.verify(token, JWT_SECRET);
        req.user = user;
        return next();
    } catch (err) {
        // Ignore and try Firebase
    }

    // 2. Try Firebase ID Token
    try {
        console.log("Verifying Firebase Token...");
        const decodedToken = await admin.auth().verifyIdToken(token);
        const uid = decodedToken.uid;
        console.log("Token Verified. UID:", uid, "Email:", decodedToken.email);

        if (!req.db) {
            console.error("CRITICAL: req.db is undefined in auth middleware!");
            return res.sendStatus(500);
        }

        // Find user by firebaseUid or email
        const user = await req.db.collection('users').findOne({
            $or: [{ firebaseUid: uid }, { email: decodedToken.email }]
        });

        if (user) {
            console.log("User found in MongoDB:", user._id);
            req.user = {
                id: user._id,
                email: user.email,
                role: user.role,
                firebaseUid: user.firebaseUid
            };
            return next();
        } else {
            console.log("User NOT found in MongoDB for UID:", uid);
        }
    } catch (e) {
        console.error("Auth Middleware Error:", e.message);
    }

    console.log("Auth Failed: Returning 403");
    return res.sendStatus(403);
};

const authorizeAdmin = (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ message: "Admin privileges required" });
    }
};

module.exports = { authenticateToken, authorizeAdmin };
