const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { ObjectId } = require('mongodb');

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

        if (userRole === 'customer') {
            const token = jwt.sign(
                { id: result.insertedId, email: email, role: userRole },
                JWT_SECRET,
                { expiresIn: '1d' }
            );

            res.status(201).json({
                token,
                user: {
                    id: result.insertedId,
                    email,
                    name,
                    role: userRole,
                    status: 'Active',
                }
            });
        } else {
            // For Vendors and Riders, require approval
            res.status(201).json({
                success: true,
                message: "Registration successful. Please wait for admin approval."
            });
        }

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

        if (user.status === 'Pending') {
            return res.status(403).json({ message: "Your account is pending approval from admin." });
        }

        if (user.status === 'Blocked' || user.status === 'Rejected') {
            return res.status(403).json({ message: "Your account has been blocked or rejected." });
        }

        const token = jwt.sign(
            { id: user._id, email: user.email, role: user.role },
            JWT_SECRET,
            { expiresIn: '1d' }
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
                shopImage: user.shopImage
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
            shopImage: user.shopImage
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

module.exports = router;
