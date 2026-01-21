/**
 * Calculate distance between two coordinates in meters
 * @param {Object} coord1 { latitude, longitude }
 * @param {Object} coord2 { latitude, longitude }
 * @returns {number} Distance in meters
 */
function calculateDistance(coord1, coord2) {
    if (!coord1 || !coord2 || !coord1.latitude || !coord1.longitude || !coord2.latitude || !coord2.longitude) {
        return Infinity;
    }

    const R = 6371e3; // Earth radius in meters
    const phi1 = coord1.latitude * Math.PI / 180;
    const phi2 = coord2.latitude * Math.PI / 180;
    const deltaPhi = (coord2.latitude - coord1.latitude) * Math.PI / 180;
    const deltaLambda = (coord2.longitude - coord1.longitude) * Math.PI / 180;

    const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
        Math.cos(phi1) * Math.cos(phi2) *
        Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

module.exports = { calculateDistance };
