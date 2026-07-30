const jwt = require('jsonwebtoken');

/**
 * Generates a signed JWT token for an authenticated user/entity
 * @param {Object} user - User object containing id, role, and optional shop_id / rider_id
 */
function generateUserToken(user) {
    return jwt.sign(
        {
            userId: user.id,
            role: user.role, // 'buyer', 'rider', 'vendor', or 'admin'
            shopId: user.shop_id || null,
            riderId: user.rider_id || null
        },
        process.env.JWT_SECRET || 'fallback_secret',
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
}

module.exports = {
    generateUserToken
};