const admin = require('./firebase');

function initZoneRequestListeners() {
    console.log("Initializing zone request listeners...");
    const db = admin.firestore();
    
    let initialLoad = true;
    
    db.collection('zone_requests')
      .where('status', '==', 'pending')
      .onSnapshot((snapshot) => {
          if (initialLoad) {
              initialLoad = false;
              return; // Skip existing
          }
          
          snapshot.docChanges().forEach((change) => {
              if (change.type === 'added') {
                  const data = change.doc.data();
                  console.log("New Delivery Zone Request:", data.address);
                  
                  // Send Firebase Push Notification to Admin Panel
                  const payload = {
                      notification: {
                          title: "New Delivery Zone Request",
                          body: `A user at ${data.address || 'Unknown'} is requesting delivery.`,
                      },
                      data: {
                          type: 'zone_request',
                          id: change.doc.id,
                          latitude: String(data.latitude),
                          longitude: String(data.longitude)
                      },
                      topic: "admin_notifications"
                  };
                  
                  admin.messaging().send(payload)
                      .then((response) => console.log("Sent zone request notification successfully"))
                      .catch((error) => console.error("Error sending zone request notification:", error));
              }
          });
      }, (error) => {
          console.error("Zone request listener error:", error);
      });
}

module.exports = { initZoneRequestListeners };
