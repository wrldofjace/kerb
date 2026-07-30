const logger = require('./logger');
const { AppError } = require('../middleware/errorHandler');

/**
 * Calculates the straight-line (great-circle) distance between two GPS coordinates using the Haversine formula.
 *
 * @param {number|string} lat1 - Latitude of origin point
 * @param {number|string} lon1 - Longitude of origin point
 * @param {number|string} lat2 - Latitude of destination point
 * @param {number|string} lon2 - Longitude of destination point
 * @returns {number} Distance in kilometers rounded to two decimal places
 */
const calculateHaversineDistance = (lat1, lon1, lat2, lon2) => {
    const originLat = parseFloat(lat1);
    const originLon = parseFloat(lon1);
    const destLat = parseFloat(lat2);
    const destLon = parseFloat(lon2);

    // Validate that coordinates are numeric and within valid GPS ranges
    if (
        isNaN(originLat) || isNaN(originLon) || isNaN(destLat) || isNaN(destLon) ||
        Math.abs(originLat) > 90 || Math.abs(destLat) > 90 ||
        Math.abs(originLon) > 180 || Math.abs(destLon) > 180
    ) {
        logger.warn(`[Distance Calc Error] Invalid coordinates supplied: (${lat1}, ${lon1}) to (${lat2}, ${lon2})`);
        throw new AppError('Invalid GPS coordinates provided for distance calculation', 400);
    }

    const EARTH_RADIUS_KM = 6371;

    // Convert degrees to radians
    const dLat = (destLat - originLat) * (Math.PI / 180);
    const dLon = (destLon - originLon) * (Math.PI / 180);

    const radLat1 = originLat * (Math.PI / 180);
    const radLat2 = destLat * (Math.PI / 180);

    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(radLat1) * Math.cos(radLat2) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);

    // Clamp 'a' between 0 and 1 to prevent floating-point precision issues that lead to NaN in Math.sqrt(1 - a)
    const clampedA = Math.min(1, Math.max(0, a));

    const c = 2 * Math.atan2(Math.sqrt(clampedA), Math.sqrt(1 - clampedA));
    const distance = EARTH_RADIUS_KM * c;

    return parseFloat(distance.toFixed(2));
};

/**
 * Computes final delivery fee based on distance brackets.
 *
 * Base Fee: KES 150 for up to 3 km
 * Extra Rate: KES 30 per additional km
 *
 * @param {number|string} distanceInKm - Distance in kilometers
 * @returns {number} Final calculated fee rounded to nearest integer
 */
const calculateDeliveryFee = (distanceInKm) => {
    const parsedDistance = parseFloat(distanceInKm);

    if (isNaN(parsedDistance) || parsedDistance < 0) {
        logger.warn(`[Delivery Fee Calc Error] Invalid distance parameter: ${distanceInKm}`);
        throw new AppError('Invalid distance provided for delivery fee calculation', 400);
    }

    const BASE_FEE = 150;
    const PER_KM_RATE = 30;
    const BASE_DISTANCE_LIMIT = 3;

    if (parsedDistance <= BASE_DISTANCE_LIMIT) {
        return BASE_FEE;
    }

    const extraDistance = parsedDistance - BASE_DISTANCE_LIMIT;
    const extraFee = extraDistance * PER_KM_RATE;

    const finalFee = Math.round(BASE_FEE + extraFee);

    logger.debug(`[Delivery Fee] Distance: ${parsedDistance} km -> Fee: KES ${finalFee}`);

    return finalFee;
};

module.exports = {
    calculateHaversineDistance,
    calculateDeliveryFee
};