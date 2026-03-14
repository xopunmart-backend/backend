require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');
const fs = require('fs');

async function run() {
  const uri = process.env.MONGO_URI;
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('xopunmart');
    const vendorId = "69744421de0b5b0403ccccb0";

    const query = { vendorId: new ObjectId(vendorId) };
    const allProducts = await db.collection('products').find(query).toArray();
    console.log("allProducts length:", allProducts.length);

    const vendorIds = [...new Set(allProducts.map(p => p.vendorId).filter(id => id))];
    const vendors = await db.collection('users').find({ _id: { $in: vendorIds } }).toArray();
    
    const vendorMap = {};
    vendors.forEach(v => vendorMap[v._id.toString()] = v);

    allProducts.forEach(p => {
        if (p.vendorId && vendorMap[p.vendorId.toString()]) {
            p.vendor = vendorMap[p.vendorId.toString()];
        } else {
            p.vendor = {};
        }
    });

    const now = new Date();
    const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    const options = { timeZone: 'Asia/Kolkata', hour12: true, hour: 'numeric', minute: 'numeric' };
    const formatter = new Intl.DateTimeFormat('en-US', { ...options, weekday: 'short' });
    const parts = formatter.formatToParts(now);
    const dayPart = parts.find(p => p.type === 'weekday').value;

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
        if (!product.vendor) return true;
        if (product.vendor.isOnline === false) return false;
        if (!product.vendor.storeTimings) return true;

        const timings = product.vendor.storeTimings;
        const todayTiming = timings[dayPart];

        console.log("Checking product:", product.name, "todayTiming:", todayTiming);

        if (!todayTiming) return true;
        if (todayTiming === 'Closed') return false;

        try {
            const startMins = parseTime(todayTiming.start);
            const endMins = parseTime(todayTiming.end);
            console.log(`currentMinutes: ${currentMinutes}, startMins: ${startMins}, endMins: ${endMins}`);
            return currentMinutes >= startMins && currentMinutes <= endMins;
        } catch (e) {
            console.log("Error parsing timings:", e);
            return true;
        }
    });

    console.log("Final products length:", products.length);
  } finally {
    await client.close();
  }
}

run();
