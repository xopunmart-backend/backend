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

        res.status(201).json({
            token,
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

        res.json({
            token,
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
                isOnline: user.isOnline
            }
        });

    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// GET /api/auth/profile
router.get('/profile', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ message: "No token provided" });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await req.db.collection('users').findOne({ _id: new ObjectId(decoded.id) });

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
            shopLocation: user.shopLocation,
            shopImage: user.shopImage,
            profileImage: user.profileImage,
            vehicleType: user.vehicleType,
            vehiclePlate: user.vehiclePlate,
            licenseNumber: user.licenseNumber,
            licenseImage: user.licenseImage,
            isOnline: user.isOnline,
            savedAddresses: user.savedAddresses || [],
            bankDetails: user.bankDetails || {}
        });
    } catch (error) {
        console.error("Profile fetch error:", error);
        res.status(401).json({ message: "Invalid token" });
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

        const decoded = jwt.verify(token, JWT_SECRET);
        const { name, phone, email, password, shopImage, shopCategories, shopCategory } = req.body;
        const userId = new ObjectId(decoded.id);

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

        const decoded = jwt.verify(tokenHeader, JWT_SECRET);
        console.log("FCM Token Update - Decoded ID:", decoded.id);
        const { fcmToken } = req.body;
        console.log("FCM Token in Body:", fcmToken);

        if (!fcmToken) {
            return res.status(400).json({ message: "FCM token is required" });
        }

        const userId = decoded.id;

        // Update MongoDB - REMOVED fcmToken update as per requirement
        // Only updating updatedAt
        await req.db.collection('users').updateOne(
            { _id: new ObjectId(userId) },
            { $set: { updatedAt: new Date() } }
        );

        // SYNC TO FIRESTORE (Primary storage for FCM Token now)
        try {
            const admin = require('../firebase');
            await admin.firestore().collection('users').doc(userId).set({
                fcmToken: fcmToken
            }, { merge: true });
            console.log("Synced FCM token to Firestore for:", userId);
        } catch (fsError) {
            console.error("Firestore Sync Error (FCM Token):", fsError);
        }

        res.json({ success: true, message: "FCM token updated" });
    } catch (error) {
        console.error("FCM Token update error:", error);
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return res.status(401).json({ message: "Invalid or expired token" });
        }
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

module.exports = router;
