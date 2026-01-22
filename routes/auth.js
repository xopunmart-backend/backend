const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { ObjectId } = require('mongodb');
const admin = require('../firebase');

const JWT_SECRET = process.env.JWT_SECRET || 'xopunmart_secret_key_123';

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
    try {
        const { name, email, password, phone, role, shopCategory, shopLocation, shopImage } = req.body;

        if (!name || !email || !password || !phone) {
            return res.status(400).json({ message: "All fields are required" });
        }

        const existingUser = await req.db.collection('users').findOne({ email: email });
        if (existingUser) {
            return res.status(400).json({ message: "User already exists" });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const userRole = role || 'vendor'; // Default to vendor if not provided

        const newUser = {
            name,
            email,
            phone,
            password: hashedPassword,
            role: userRole,
            status: 'Pending', // Vendors/Riders might need approval
            isOnline: false, // Default to offline
            createdAt: new Date(),
            updatedAt: new Date()
        };

        if (req.body.shopCategories && Array.isArray(req.body.shopCategories)) {
            newUser.shopCategories = req.body.shopCategories;
            // Set primary category for backward compatibility
            if (newUser.shopCategories.length > 0) {
                newUser.shopCategory = newUser.shopCategories[0];
            }
        } else if (shopCategory) {
            // Fallback for old clients sending single category
            newUser.shopCategory = shopCategory;
            newUser.shopCategories = [shopCategory];
        }

        if (shopLocation) {
            // Expecting { latitude: Number, longitude: Number, address: String }
            newUser.shopLocation = shopLocation;
        }

        if (shopImage) {
            newUser.shopImage = shopImage;
        }

        const result = await req.db.collection('users').insertOne(newUser);

        // Generate token for ALL users (Customer, Rider, Vendor)
        const token = jwt.sign(
            { id: result.insertedId, email: email, role: userRole },
            JWT_SECRET,
            { expiresIn: '365d' }
        );

        // Generate Firebase Custom Token (for Vendor App mostly, to sync IDs)
        let firebaseToken = null;
        try {
            firebaseToken = await admin.auth().createCustomToken(result.insertedId.toString(), { role: userRole });
        } catch (ftError) {
            console.error("Error generating firebase token:", ftError);
        }



        res.status(201).json({
            token,
            firebaseToken, // Send custom token
            user: {
                id: result.insertedId,
                email,
                name,
                role: userRole,
                status: userRole === 'customer' ? 'Active' : 'Pending', // Explicitly set status
            },
            message: userRole === 'customer'
                ? "Registration successful"
                : "Registration successful. Please wait for admin approval."
        });

    } catch (error) {
        console.error("Signup error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ message: "Email and password are required" });
        }

        const user = await req.db.collection('users').findOne({ email: email });

        if (!user) {
            return res.status(401).json({ message: "Invalid email or password" });
        }

        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return res.status(401).json({ message: "Invalid email or password" });
        }

        // if (user.status === 'Pending') {
        //     return res.status(403).json({ message: "Your account is pending approval from admin." });
        // }

        if (user.status === 'Blocked' || user.status === 'Rejected') {
            return res.status(403).json({ message: "Your account has been blocked or rejected." });
        }

        const token = jwt.sign(
            { id: user._id, email: user.email, role: user.role },
            JWT_SECRET,
            { expiresIn: '365d' }
        );

        // Generate Firebase Custom Token
        let firebaseToken = null;
        try {
            firebaseToken = await admin.auth().createCustomToken(user._id.toString(), { role: user.role });
        } catch (ftError) {
            console.error("Error generating firebase token (Login):", ftError);
        }

        res.json({
            token,
            firebaseToken, // Send custom token
            user: {
                id: user._id,
                email: user.email,
                name: user.name,
                phone: user.phone, // Added phone
                role: user.role,
                shopCategory: user.shopCategory,
                shopCategories: user.shopCategories || [],
                liveLocation: user.liveLocation,
                shopLocation: user.shopLocation,
                shopImage: user.shopImage,
                isOnline: user.isOnline,
                firebaseUid: user.firebaseUid // Send back if exists
            }
        });

    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// POST /api/auth/firebase-login
router.post('/firebase-login', async (req, res) => {
    try {
        const { idToken, name, email, phone, role } = req.body;

        if (!idToken) {
            return res.status(400).json({ message: "ID Token is required" });
        }

        // 1. Verify Firebase Token
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const { uid, email: firebaseEmail } = decodedToken;

        console.log(`Firebase Auth: Verified user ${uid} (${firebaseEmail})`);

        // 2. Find or Create User in MongoDB
        let user = await req.db.collection('users').findOne({
            $or: [{ firebaseUid: uid }, { email: firebaseEmail }]
        });

        const userRole = role || (user ? user.role : 'vendor'); // Default to vendor for new users if not specified

        if (user) {
            // Update existing user with UID if missing
            if (!user.firebaseUid) {
                await req.db.collection('users').updateOne(
                    { _id: user._id },
                    { $set: { firebaseUid: uid, updatedAt: new Date() } }
                );
                user.firebaseUid = uid;
            }
        } else {
            // Create New User
            const newUser = {
                name: name || 'New User',
                email: firebaseEmail,
                phone: phone || '',
                role: userRole,
                firebaseUid: uid,
                status: 'Pending', // Pending approval
                isOnline: false,
                createdAt: new Date(),
                updatedAt: new Date()
            };
            const result = await req.db.collection('users').insertOne(newUser);
            user = { ...newUser, _id: result.insertedId };
        }

        // 3. Return User Data (The App will strictly use Firebase User for its session, but needs Mongo ID for business logic)
        res.json({
            success: true,
            user: {
                id: user._id,
                email: user.email,
                name: user.name,
                role: user.role,
                status: user.status,
                phone: user.phone,
                shopCategory: user.shopCategory,
                firebaseUid: uid
            }
        });

    } catch (error) {
        console.error("Firebase Login Error:", error);
        console.error("Token received (first 20 chars):", req.body.idToken ? req.body.idToken.substring(0, 20) : "NONE");
        console.error("Error Code:", error.code);
        console.error("Error Message:", error.message);
        res.status(401).json({ message: "Invalid ID Token", error: error.message });
    }
});

// PUT /api/auth/firebase-uid
router.put('/firebase-uid', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ message: "No token provided" });

        const decoded = jwt.verify(token, JWT_SECRET);
        const { firebaseUid } = req.body;

        if (!firebaseUid) return res.status(400).json({ message: "Firebase UID required" });

        await req.db.collection('users').updateOne(
            { _id: new ObjectId(decoded.id) },
            { $set: { firebaseUid: firebaseUid, updatedAt: new Date() } }
        );

        res.json({ success: true, message: "Firebase UID linked" });
    } catch (error) {
        console.error("Firebase UID sync error:", error);
        res.status(401).json({ message: "Invalid token" });
    }
});

// GET /api/auth/profile
router.get('/profile', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ message: "No token provided" });
        }

        let user;

        // Strategy 1: Try Firebase ID Token
        try {
            const decodedFirebase = await admin.auth().verifyIdToken(token);
            // specific query for firebase user
            user = await req.db.collection('users').findOne({ $or: [{ firebaseUid: decodedFirebase.uid }, { email: decodedFirebase.email }] });
            // If user found via email but no firebaseUid, sync it? (Optional, skipping for read-only)
        } catch (firebaseError) {
            // Strategy 2: Try JWT (Legacy)
            try {
                const decodedJwt = jwt.verify(token, JWT_SECRET);
                user = await req.db.collection('users').findOne({ _id: new ObjectId(decodedJwt.id) });
            } catch (jwtError) {
                return res.status(401).json({ message: "Invalid token" });
            }
        }

        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        res.json({
            id: user._id,
            name: user.name,
            email: user.email,
            phone: user.phone,
            role: user.role,
            status: user.status,
            shopCategory: user.shopCategory,
            shopCategories: user.shopCategories || [],
            liveLocation: user.liveLocation,
            shopLocation: user.shopLocation,
            shopImage: user.shopImage,
            profileImage: user.profileImage,
            vehicleType: user.vehicleType,
            vehiclePlate: user.vehiclePlate,
            licenseNumber: user.licenseNumber,
            licenseImage: user.licenseImage,
            isOnline: user.isOnline,
            savedAddresses: user.savedAddresses || [],
            bankDetails: user.bankDetails || {},
            firebaseUid: user.firebaseUid
        });
    } catch (error) {
        console.error("Profile fetch error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// GET /api/auth/status?email=...
router.get('/status', async (req, res) => {
    try {
        const { email } = req.query;
        if (!email) {
            return res.status(400).json({ message: "Email is required" });
        }

        const user = await req.db.collection('users').findOne({ email: email });
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        res.json({ status: user.status, role: user.role, id: user._id });
    } catch (error) {
        console.error("Status check error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// PUT /api/auth/profile
router.put('/profile', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ message: "No token provided" });
        }

        let userId;

        // Strategy 1: Firebase ID Token
        try {
            const decodedFirebase = await admin.auth().verifyIdToken(token);
            const user = await req.db.collection('users').findOne({ $or: [{ firebaseUid: decodedFirebase.uid }, { email: decodedFirebase.email }] });
            if (!user) {
                return res.status(404).json({ message: "User not found" });
            }
            userId = user._id; // Use MongoDB ID for updates
        } catch (firebaseError) {
            // Strategy 2: JWT (Legacy)
            try {
                const decoded = jwt.verify(token, JWT_SECRET);
                userId = new ObjectId(decoded.id);
            } catch (jwtError) {
                return res.status(401).json({ message: "Invalid token" });
            }
        }

        const { name, phone, email, password, shopImage, shopCategories, shopCategory } = req.body;

        const updates = { updatedAt: new Date() };
        if (name) updates.name = name;
        if (phone) updates.phone = phone;
        if (shopImage) updates.shopImage = shopImage;
        if (req.body.profileImage) updates.profileImage = req.body.profileImage;

        // Email update with uniqueness check
        if (email) {
            const existingUser = await req.db.collection('users').findOne({ email: email });
            if (existingUser && existingUser._id.toString() !== userId.toString()) {
                return res.status(400).json({ message: "Email is already in use by another account" });
            }
            updates.email = email;
        }

        // Password update with hashing
        if (password) {
            const salt = await bcrypt.genSalt(10);
            updates.password = await bcrypt.hash(password, salt);
        }

        if (req.body.isOnline !== undefined) {
            updates.isOnline = req.body.isOnline;
        }

        if (req.body.shopCategories) {
            updates.shopCategories = req.body.shopCategories;
            if (req.body.shopCategories.length > 0) {
                updates.shopCategory = req.body.shopCategories[0];
            }
        } else if (req.body.shopCategory) {
            updates.shopCategory = req.body.shopCategory;
            updates.shopCategories = [req.body.shopCategory];
        }

        if (req.body.vehicleType) updates.vehicleType = req.body.vehicleType;
        if (req.body.vehiclePlate) updates.vehiclePlate = req.body.vehiclePlate;
        if (req.body.licenseNumber) updates.licenseNumber = req.body.licenseNumber;
        if (req.body.licenseImage) updates.licenseImage = req.body.licenseImage;

        if (req.body.bankDetails) {
            updates.bankDetails = req.body.bankDetails;
        }

        if (req.body.savedAddresses) {
            updates.savedAddresses = req.body.savedAddresses;
        }

        const result = await req.db.collection('users').updateOne(
            { _id: userId },
            { $set: updates }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ message: "User not found" });
        }

        res.json({ success: true, message: "Profile updated successfully" });

    } catch (error) {
        console.error("Profile update error:", error);
        res.status(401).json({ message: error.message || "Invalid token or server error", error: error.toString() });
    }
});

// POST /api/auth/fcm-token
router.post('/fcm-token', async (req, res) => {
    try {
        const tokenHeader = req.headers.authorization?.split(' ')[1];
        if (!tokenHeader) {
            return res.status(401).json({ message: "No token provided" });
        }

        // Just return success for backward compatibility or if app calls it
        // The real work is done in Firestore now
        res.json({ success: true, message: "FCM token deprecated in Mongo" });

    } catch (error) {
        console.error("FCM Token update error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

module.exports = router;
