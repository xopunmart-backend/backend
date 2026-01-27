const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');

// GET /api/settings
// Retrieve current settings (or defaults if not set)
router.get('/', async (req, res) => {
    try {
        const settings = await req.db.collection('settings').findOne({ type: 'global_config' });

        if (!settings) {
            // Return defaults if no settings found
            return res.json({
                deliveryZones: [{
                    latitude: 26.1445, // Default: Guwahati
                    longitude: 91.7362,
                    radiusKm: 5,
                    baseDeliveryFee: 40,
                    freeDeliveryThreshold: 500
                }],
                handlingFee: 5,
                deliveryCharge: 20,
                freeDeliveryThreshold: 500,
                freeDeliveryFirstXOrders: 0,
                baseDeliveryFee: 40, // Legacy fallback
                riderEarning: 15, // Default base rider earning
                extraShopRiderFee: 10, // Default per extra shop earning
                multiVendorFee: 10 // Default per extra shop charge to customer
            });
        }

        // Backward compatibility: If deliveryZone (single) exists but deliveryZones (array) doesn't, migrate it.
        if (settings.config.deliveryZone && !settings.config.deliveryZones) {
            settings.config.deliveryZones = [settings.config.deliveryZone];
        }

        res.json(settings.config);
    } catch (error) {
        console.error("Error fetching settings:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// POST /api/settings
// Update settings
router.post('/', async (req, res) => {
    try {
        const config = req.body; // Expecting the full config object

        if (!config) {
            return res.status(400).json({ message: "No config data provided" });
        }

        // Upsert the settings document
        await req.db.collection('settings').updateOne(
            { type: 'global_config' },
            {
                $set: {
                    type: 'global_config',
                    config: config,
                    updatedAt: new Date()
                }
            },
            { upsert: true }
        );

        res.json({ message: "Settings updated successfully", config });
    } catch (error) {
        console.error("Error updating settings:", error);
        res.status(500).json({ message: "Server error" });
    }
});

module.exports = router;
