const express = require('express');
const { ObjectId } = require('mongodb');
const router = express.Router();

// GET all products (with optional vendorId filter)
router.get('/', async (req, res) => {
    try {
        const { vendorId, category } = req.query;
        const query = {};
        if (vendorId) {
            query.vendorId = new ObjectId(vendorId);
        }
        if (category) {
            query.category = category; // Assuming category is stored as string name or ID. Based on current data it seems to be string name in some places, or ID. Let's check schemas if possible, but usually category name or ID. Sticking to simple string match or checking how category is stored. 
            // Wait, looking at other files, category might be text. Let's assume text for now or ID if referring to category collection. 
            // In add product, it just sends body. 
            // Ideally should be consistent.
        }

        const allProducts = await req.db.collection('products').aggregate([
            { $match: query },
            {
                $lookup: {
                    from: 'users',
                    localField: 'vendorId',
                    foreignField: '_id',
                    as: 'vendor'
                }
            },
            {
                $unwind: '$vendor' // Unwind to access vendor fields easily
            },
            {
                $addFields: {
                    vendorName: '$vendor.name',
                    vendorStoreTimings: '$vendor.storeTimings',
                    isShopOpen: {
                        $function: {
                            body: function (storeTimings) {
                                if (!storeTimings) return true; // Default to open if no timings

                                // Get current time in India (IST) - adjusting for server timezone if needed
                                // Assuming server is UTC, add 5.5 hours. 
                                // If server is already local, this might need adjustment.
                                // Best to use a library or consistent offset. 
                                // Basic native implementation:
                                const now = new Date();
                                // Create date object for IST
                                const offset = 5.5 * 60 * 60 * 1000;
                                const istDate = new Date(now.getTime() + offset);
                                // ACTUALLY: new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"}) is better but $function might not support full node env.
                                // MongoDB $function runs in JS engine on server. 
                                // Let's simplify: Do filtering in APPLICATION layer (Node.js) after fetch, 
                                // it is safer and easier to debug timezones.
                            },
                            args: ['$vendor.storeTimings'],
                            lang: 'js'
                        }
                    }
                }
            }
        ]).toArray();

        // Application Layer Filtering for Open/Closed logic
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const now = new Date();
        // Adjust for IST (UTC+5:30) if server is UTC
        // This is a naive check. For production, consider using moment-timezone or explicit offsets.
        // Assuming server is UTC:
        const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
        const currentDay = days[istTime.getUTCDay()]; // getUTCDay because we added offset to make it "IST time" but as a UTC number
        // Wait, better way:
        const options = { timeZone: 'Asia/Kolkata', hour12: true, hour: 'numeric', minute: 'numeric' };
        const formatter = new Intl.DateTimeFormat('en-US', { ...options, weekday: 'short' });
        const parts = formatter.formatToParts(now);
        const dayPart = parts.find(p => p.type === 'weekday').value; // "Mon", "Tue"

        // Custom parser for "09:00 AM"
        const parseTime = (timeStr) => {
            const [time, modifier] = timeStr.split(' ');
            let [hours, minutes] = time.split(':');
            hours = parseInt(hours, 10);
            minutes = parseInt(minutes, 10);
            if (hours === 12 && modifier === 'AM') hours = 0;
            if (hours !== 12 && modifier === 'PM') hours += 12;
            return hours * 60 + minutes;
        };

        const currentMinutes = istTime.getUTCHours() * 60 + istTime.getUTCMinutes();

        const products = allProducts.filter(product => {
            const timings = product.vendor.storeTimings;
            if (!timings) return true; // Default Open

            const todayTiming = timings[dayPart] || timings[currentDay]; // Try matched day
            if (!todayTiming) return true; // No timing for today, assume open? Or closed? Default Open.

            if (todayTiming === 'Closed') return false;

            try {
                const startMins = parseTime(todayTiming.start);
                const endMins = parseTime(todayTiming.end);

                // Handle overnight? (e.g. 10 PM to 2 AM). 
                // For now assuming same-day timings as per UI (09:00 AM - 10:00 PM)
                return currentMinutes >= startMins && currentMinutes <= endMins;
            } catch (e) {
                return true; // Error parsing, default open
            }
        }).map(p => {
            // Clean up vendor object to not expose secrets, but keep storeTimings if needed by frontend
            const { vendor, ...rest } = p;
            return { ...rest, vendorName: vendor.name, vendorId: vendor._id };
        });

        res.json(products);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// GET product by ID
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid Product ID" });
        }
        const product = await req.db.collection('products').findOne({ _id: new ObjectId(id) });

        if (!product) {
            return res.status(404).json({ message: "Product not found" });
        }

        res.json(product);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// POST new product
router.post('/', async (req, res) => {
    try {
        const newProduct = req.body;
        // Basic validation
        if (!newProduct.name || !newProduct.price || !newProduct.vendorId) {
            return res.status(400).json({ message: "Name, price, and vendorId are required" });
        }

        // Convert vendorId to ObjectId
        newProduct.vendorId = new ObjectId(newProduct.vendorId);

        // Validate Shop Category if vendor has one
        const vendor = await req.db.collection('users').findOne({ _id: newProduct.vendorId });
        if (vendor) {
            const allowedCategories = vendor.shopCategories || (vendor.shopCategory ? [vendor.shopCategory] : []);

            if (allowedCategories.length > 0 && !allowedCategories.includes(newProduct.category)) {
                return res.status(400).json({
                    message: `You can only add products to your registered categories: ${allowedCategories.join(', ')}`
                });
            }
        }

        // Set defaults for new fields
        newProduct.sku = newProduct.sku || 'SKU-' + Date.now();
        // Allow stock to be null if explicitly sent as null (or missing -> 0)
        if (newProduct.stock === undefined) newProduct.stock = 0;

        newProduct.unit = newProduct.unit || 'pcs';
        newProduct.image = newProduct.image || '';
        newProduct.lowStockThreshold = newProduct.lowStockThreshold || 10;
        // Vendor created products should be pending by default
        newProduct.approvalStatus = 'pending';
        // Handle availability based on stock (treat null as out of stock for now or in-stock? 
        // If null (unlimited?), usually implies in-stock. If 0, out. 
        // For now, let's keep simple: stock > 0 is in-stock. null > 0 is false.
        newProduct.availability = (newProduct.stock && newProduct.stock > 0) ? 'in-stock' : 'out-of-stock';

        newProduct.createdAt = new Date();
        newProduct.updatedAt = new Date();

        const result = await req.db.collection('products').insertOne(newProduct);
        res.status(201).json({ ...newProduct, _id: result.insertedId });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

// PUT update product
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        delete updates._id; // Prevent updating _id
        updates.updatedAt = new Date();

        const result = await req.db.collection('products').findOneAndUpdate(
            { _id: new ObjectId(id) },
            { $set: updates },
            { returnDocument: 'after' }
        );

        if (!result) {
            return res.status(404).json({ message: "Product not found" });
        }

        res.json(result);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

// PATCH update product approval status
router.patch('/:id/approval', async (req, res) => {
    try {
        const { id } = req.params;
        const { approvalStatus } = req.body;

        if (!['pending', 'approved', 'rejected'].includes(approvalStatus)) {
            return res.status(400).json({ message: "Invalid approval status" });
        }

        const result = await req.db.collection('products').findOneAndUpdate(
            { _id: new ObjectId(id) },
            {
                $set: {
                    approvalStatus,
                    updatedAt: new Date()
                }
            },
            { returnDocument: 'after' }
        );

        if (!result) {
            return res.status(404).json({ message: "Product not found" });
        }

        res.json(result);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

// DELETE product
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await req.db.collection('products').deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount === 0) {
            return res.status(404).json({ message: "Product not found" });
        }

        res.json({ message: "Product deleted" });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
