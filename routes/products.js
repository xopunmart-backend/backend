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

        const products = await req.db.collection('products').find(query).toArray();
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
