const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');

// GET /api/seed/admin
router.get('/admin', async (req, res) => {
    try {
        const email = 'xopunmart@gmail.com';
        const password = '123456';
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const result = await req.db.collection('users').updateOne(
            { email: email },
            {
                $set: {
                    email: email,
                    password: hashedPassword,
                    role: 'admin',
                    name: 'Super Admin',
                    updatedAt: new Date()
                },
                $setOnInsert: { createdAt: new Date() }
            },
            { upsert: true }
        );

        res.json({ message: "Admin seeded successfully", result });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
