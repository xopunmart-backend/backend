const express = require('express');
const router = express.Router();
const admin = require('../firebase');
const crypto = require('crypto');

// POST /api/upload
router.post('/', async (req, res) => {
    try {
        const { image, folder } = req.body;

        if (!image) {
            return res.status(400).json({ message: "No image provided" });
        }

        let mimeType = 'image/jpeg';
        let base64Data = image;
        let fileExtension = 'jpg';

        const mimeMatch = image.match(/^data:([^;]+);base64,/);
        if (mimeMatch) {
            mimeType = mimeMatch[1];
            base64Data = image.substring(mimeMatch[0].length);
            
            const extMatch = mimeType.match(/\/([a-zA-Z0-9+.-]+)$/);
            if (extMatch) {
                fileExtension = extMatch[1];
            }
        }
        
        const buffer = Buffer.from(base64Data, 'base64');
        const token = crypto.randomUUID();
        
        // Construct the file path inside the bucket
        const folderName = folder ? folder.trim().replace(/\/+$/, '') : 'xopunmart/general';
        const fileName = `${folderName}/${crypto.randomUUID()}.${fileExtension}`;

        const bucket = admin.storage().bucket();
        const file = bucket.file(fileName);

        // Upload buffer directly to Firebase Storage
        await file.save(buffer, {
            metadata: {
                contentType: mimeType,
                metadata: {
                    firebaseStorageDownloadTokens: token
                }
            }
        });

        // Construct standard Firebase download URL
        const publicUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(fileName)}?alt=media&token=${token}`;

        res.json({
            url: publicUrl,
            public_id: fileName
        });

    } catch (error) {
        console.error("Firebase Storage upload error:", error);
        res.status(500).json({ message: "Image upload failed", error: error.message });
    }
});

module.exports = router;
