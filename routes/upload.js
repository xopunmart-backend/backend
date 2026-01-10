const express = require('express');
const router = express.Router();
const cloudinary = require('../utils/cloudinary');

// POST /api/upload
router.post('/', async (req, res) => {
    try {
        const { image, folder } = req.body;

        if (!image) {
            return res.status(400).json({ message: "No image provided" });
        }

        const options = {
            upload_preset: process.env.CLOUDINARY_UPLOAD_PRESET, // Optional if using presets
        };

        if (folder) {
            options.folder = folder;
        }

        // Upload to Cloudinary
        const uploadResult = await cloudinary.uploader.upload(image, options);

        res.json({
            url: uploadResult.secure_url,
            public_id: uploadResult.public_id,
            ...uploadResult
        });

    } catch (error) {
        console.error("Cloudinary upload error:", error);
        res.status(500).json({ message: "Image upload failed", error: error.message });
    }
});

module.exports = router;
