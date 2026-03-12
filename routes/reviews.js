const express = require('express');
const { ObjectId } = require('mongodb');
const router = express.Router();

// GET all reviews for a specific product
router.get('/', async (req, res) => {
    try {
        const { productId } = req.query;

        if (!productId || !ObjectId.isValid(productId)) {
            return res.status(400).json({ message: "Valid Product ID is required" });
        }

        const query = { productId: new ObjectId(productId) };

        // Fetch reviews
        const reviews = await req.db.collection('reviews').find(query).sort({ createdAt: -1 }).toArray();

        // Get unique user IDs to populate customer names and avatars
        const userIds = [...new Set(reviews.map(r => r.userId).filter(id => id))];

        const users = await req.db.collection('users').find({ _id: { $in: userIds } }).toArray();
        const userMap = {};
        users.forEach(u => userMap[u._id.toString()] = u);

        // Attach user info to reviews
        const populatedReviews = reviews.map(r => {
            const user = userMap[r.userId?.toString()] || {};
            return {
                ...r,
                user: {
                    name: user.name || 'Anonymous',
                    image: user.image || null
                }
            };
        });

        // Calculate summary
        let totalRating = 0;
        const ratingCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

        reviews.forEach(r => {
            totalRating += r.rating;
            if (ratingCounts[r.rating] !== undefined) {
                ratingCounts[r.rating]++;
            }
        });

        const totalReviews = reviews.length;
        const averageRating = totalReviews > 0 ? (totalRating / totalReviews).toFixed(1) : 0;

        res.json({
            reviews: populatedReviews,
            summary: {
                average: parseFloat(averageRating),
                total: totalReviews,
                counts: ratingCounts
            }
        });

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// POST a new review
router.post('/', async (req, res) => {
    try {
        const { productId, userId, rating, comment, images } = req.body;

        if (!productId || !ObjectId.isValid(productId)) {
            return res.status(400).json({ message: "Valid Product ID is required" });
        }
        if (!userId || !ObjectId.isValid(userId)) {
            return res.status(400).json({ message: "Valid User ID is required" });
        }
        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({ message: "Rating must be between 1 and 5" });
        }

        // Check if user has already reviewed this product
        const existingReview = await req.db.collection('reviews').findOne({
            productId: new ObjectId(productId),
            userId: new ObjectId(userId)
        });

        if (existingReview) {
            return res.status(400).json({ message: "You have already reviewed this product" });
        }

        const reviewDoc = {
            productId: new ObjectId(productId),
            userId: new ObjectId(userId),
            rating: parseInt(rating),
            comment: comment || '',
            images: images || [],
            isVerifiedPurchase: true, // Assuming for now they purchased it
            likes: 0,
            dislikes: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        const result = await req.db.collection('reviews').insertOne(reviewDoc);

        res.status(201).json({
            ...reviewDoc,
            _id: result.insertedId
        });

    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

// PUT (update) a review like/dislike count
router.put('/:id/vote', async (req, res) => {
    try {
        const { id } = req.params;
        const { type } = req.body; // 'like' or 'dislike'

        if (!['like', 'dislike'].includes(type)) {
            return res.status(400).json({ message: "Invalid vote type" });
        }

        const incrementField = type === 'like' ? 'likes' : 'dislikes';

        const result = await req.db.collection('reviews').findOneAndUpdate(
            { _id: new ObjectId(id) },
            { $inc: { [incrementField]: 1 } },
            { returnDocument: 'after' }
        );

        if (!result) {
            return res.status(404).json({ message: "Review not found" });
        }

        res.json(result);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

// DELETE a review
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { userId } = req.query; // Only the author or admin should delete it

        const query = { _id: new ObjectId(id) };
        if (userId) {
            query.userId = new ObjectId(userId);
        }

        const result = await req.db.collection('reviews').deleteOne(query);

        if (result.deletedCount === 0) {
            return res.status(404).json({ message: "Review not found or unauthorized" });
        }

        res.json({ message: "Review deleted successfully" });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
