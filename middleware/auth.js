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
        const decodedToken = await admin.auth().verifyIdToken(token);
        const uid = decodedToken.uid;

        // Find user by firebaseUid or email
        const user = await req.db.collection('users').findOne({
            $or: [{ firebaseUid: uid }, { email: decodedToken.email }]
        });

        if (user) {
            req.user = {
                id: user._id,
                email: user.email,
                role: user.role,
                firebaseUid: user.firebaseUid
            };
            return next();
        }
    } catch (e) {
        // console.error("Auth Error:", e.message);
    }

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
