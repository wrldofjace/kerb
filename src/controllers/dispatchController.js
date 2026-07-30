const asyncHandler = require('express-async-handler');
const db = require('../config/db');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');

/**
 * @desc    Find available riders within N kilometers of a shop using PostGIS geography functions
 * @route   POST /api/dispatch/nearby-riders
 * @access  Private (Vendor / Admin)
 */
exports.dispatchNearbyRiders = asyncHandler(async (req, res) => {
    const { shopId, radiusKm = 5 } = req.body;

    if (!shopId) {
        throw new AppError('shopId is required', 400);
    }

    const radiusMeters = parseFloat(radiusKm) * 1000;

    // 1. Check if the shop exists
    const shopQuery = `SELECT id, shop_name, location FROM public.shops WHERE id = $1;`;
    const shopResult = await db.query(shopQuery, [shopId]);

    if (shopResult.rows.length === 0) {
        throw new AppError('Shop not found', 404);
    }

    const shop = shopResult.rows[0];

    // 2. PostGIS Spatial Query: Find nearby available riders ordered by true earth distance (meters)
    const riderDispatchQuery = `
        SELECT 
            r.id AS rider_id,
            r.name,
            r.phone_number,
            ST_DistanceSphere(r.current_location, s.location) / 1000.0 AS distance_km
        FROM public.riders r
        CROSS JOIN public.shops s
        WHERE s.id = $1
          AND r.is_active = true
          AND r.is_available = true
          AND ST_DWithin(r.current_location::geography, s.location::geography, $2)
        ORDER BY distance_km ASC
        LIMIT 5;
    `;

    const dispatchResult = await db.query(riderDispatchQuery, [shopId, radiusMeters]);

    logger.info(`[Rider Dispatch] Found ${dispatchResult.rows.length} nearby riders within ${radiusKm}KM for Shop ID #${shopId} (${shop.shop_name})`);

    res.status(200).json({
        success: true,
        shopId: parseInt(shopId),
        shopName: shop.shop_name,
        searchRadiusKm: parseFloat(radiusKm),
        matchedRidersCount: dispatchResult.rows.length,
        nearbyRiders: dispatchResult.rows.map(r => ({
            riderId: r.rider_id,
            name: r.name,
            phone: r.phone_number,
            distanceKm: parseFloat(parseFloat(r.distance_km).toFixed(2))
        }))
    });
});