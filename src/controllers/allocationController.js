const asyncHandler = require('express-async-handler');
const db = require('../config/db');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');

/**
 * Allocates the nearest available rider to an order in 'escrow_held' status.
 */
exports.allocateRider = asyncHandler(async (req, res) => {
    const { orderId } = req.body;

    if (!orderId) {
        throw new AppError('Order ID is required', 400);
    }

    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        // 1. Lock order row for update
        const orderQuery = `
            SELECT id, status, delivery_location
            FROM public.orders
            WHERE id = $1
            FOR UPDATE;
        `;
        const orderResult = await client.query(orderQuery, [orderId]);

        if (orderResult.rows.length === 0) {
            throw new AppError('Order not found', 404);
        }

        const order = orderResult.rows[0];

        if (order.status !== 'escrow_held') {
            throw new AppError(
                `Cannot allocate rider. Order status is '${order.status}', but must be 'escrow_held'.`, 
                400
            );
        }

        if (!order.delivery_location) {
            throw new AppError('Order delivery location is missing or invalid', 400);
        }

        // 2. Find nearest available rider within 5000 meters (5 KM)
        const findRiderQuery = `
            SELECT id, name, phone_number,
                   ST_DistanceSphere(current_location, $1) AS distance_meters
            FROM public.riders
            WHERE is_active = true 
              AND is_available = true
              AND ST_DWithin(current_location::geography, $1::geography, 5000)
            ORDER BY current_location <-> $1
            LIMIT 1
            FOR UPDATE SKIP LOCKED;
        `;

        const riderResult = await client.query(findRiderQuery, [order.delivery_location]);

        if (riderResult.rows.length === 0) {
            throw new AppError('No available riders nearby within 5KM.', 404);
        }

        const closestRider = riderResult.rows[0];

        // 3. Update Order Status & Assign Rider
        const updateOrderResult = await client.query(`
            UPDATE public.orders
            SET rider_id = $1, 
                status = 'in_transit',
                updated_at = NOW()
            WHERE id = $2 AND status = 'escrow_held';
        `, [closestRider.id, orderId]);

        if (updateOrderResult.rowCount === 0) {
            throw new AppError('Order state conflict. Could not set status to in_transit.', 409);
        }

        // 4. Mark Rider as Unavailable
        await client.query(`
            UPDATE public.riders
            SET is_available = false,
                updated_at = NOW()
            WHERE id = $1;
        `, [closestRider.id]);

        await client.query('COMMIT');

        logger.info(`[Rider Allocation] Rider ${closestRider.name} (ID: ${closestRider.id}) assigned to Order ID: ${orderId}`);

        res.status(200).json({
            message: 'Rider allocated successfully',
            orderId: parseInt(orderId),
            rider: {
                id: closestRider.id,
                name: closestRider.name,
                phone: closestRider.phone_number,
                distanceAwayMeters: Math.round(closestRider.distance_meters)
            }
        });

    } catch (error) {
        // Rollback transaction for ANY error (AppError or unexpected DB error)
        await client.query('ROLLBACK');
        
        // Re-throw so express-async-handler passes it to errorHandler.js
        throw error;
    } finally {
        // Always release client back to the connection pool
        client.release();
    }
});