const admin = require('./firebase');

async function unlockApp() {
    console.log("Attempting to update app settings...");
    try {
        const db = admin.firestore();
        const settingsRef = db.collection('system_settings').doc('app_settings');
        
        const settings = {
            maintenanceMode: false,
            appOpenTime: "06:00 AM",
            appCloseTime: "11:59 PM",
            appOpenTime2: "",
            appCloseTime2: "",
            minimumAppVersion: "1.0.0",
            privacyPolicy: "https://traj.in/privacy",
            termsConditions: "https://traj.in/terms",
            closedNotice: "We are currently closed.",
            showFlashDeals: true,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        await settingsRef.set(settings, { merge: true });
        console.log("✅ SUCCESS! App successfully unlocked.");
        console.log("--------------------------------------");
        console.log("Maintenance Mode: OFF");
        console.log("New Closing Time: 11:59 PM");
        console.log("--------------------------------------");
        
        process.exit(0);
    } catch (err) {
        console.error("❌ FAILED to update settings:", err);
        process.exit(1);
    }
}

unlockApp();
