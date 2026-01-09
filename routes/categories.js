const express = require('express');
const { ObjectId } = require('mongodb');
const router = express.Router();

// GET all categories
router.get('/', async (req, res) => {
    try {
        const categories = await req.db.collection('categories').find({}).toArray();
        res.json(categories);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// POST new category
router.post('/', async (req, res) => {
    try {
        const newCategory = req.body;
        if (!newCategory.name) {
            return res.status(400).json({ message: "Name is required" });
        }

        // Set defaults for new fields
        newCategory.status = newCategory.status || 'Active';
        newCategory.subcategories = newCategory.subcategories || [];
        newCategory.icon = newCategory.icon || 'package';
        newCategory.order = newCategory.order || 0;
        newCategory.createdAt = new Date();

        const result = await req.db.collection('categories').insertOne(newCategory);
        res.status(201).json({ ...newCategory, _id: result.insertedId });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

// PUT update category
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        delete updates._id;

        const result = await req.db.collection('categories').findOneAndUpdate(
            { _id: new ObjectId(id) },
            { $set: updates },
            { returnDocument: 'after' }
        );

        if (!result) {
            return res.status(404).json({ message: "Category not found" });
        }

        res.json(result);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

// PATCH reorder categories
router.patch('/reorder', async (req, res) => {
    try {
        const { categories } = req.body;
        if (!Array.isArray(categories)) {
            return res.status(400).json({ message: "Categories array is required" });
        }

        // Update order for each category
        const bulkOps = categories.map((cat, index) => ({
            updateOne: {
                filter: { _id: new ObjectId(cat.id) },
                update: { $set: { order: index } }
            }
        }));

        await req.db.collection('categories').bulkWrite(bulkOps);
        res.json({ message: "Categories reordered successfully" });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

// DELETE category
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await req.db.collection('categories').deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount === 0) {
            return res.status(404).json({ message: "Category not found" });
        }
        res.json({ message: "Category deleted" });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
