const asyncHandler = require('express-async-handler');
const db = require('../config/db');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');

/**
 * @desc    Cancel order, release assigned rider, and reverse escrow / refund buyer
 * @route   POST /api/orders/cancel
 * @access  Private
 */
exports.cancelOrder = asyncHandler(async (req, res) => {
    const { orderId, reason } = req.body;

    if (!orderId) {
        throw new AppError('orderId is required', 400);
    }

    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        // 1. Fetch order with row lock
        const orderQuery = `
            SELECT id, status, escrow_state, total_payable, buyer_id, rider_id
            FROM public.orders
            WHERE id = $1
            FOR UPDATE;
        `;
        const orderResult = await client.query(orderQuery, [orderId]);

        if (orderResult.rows.length === 0) {
            throw new AppError('Order not found', 404);
        }

        const order = orderResult.rows[0];

        if (order.status === 'completed' || order.status === 'delivered') {
            throw new AppError('Cannot cancel an order that has already been delivered.', 400);
        }

        if (order.status === 'cancelled') {
            throw new AppError('Order is already cancelled.', 400);
        }

        // 2. Determine refund status based on escrow state
        let refundAction = 'none';
        let newEscrowState = 'none';

        if (order.escrow_state === 'held') {
            refundAction = 'refunded_to_wallet'; // Or trigger M-Pesa B2C reversal
            newEscrowState = 'refunded';
        }

        // 3. Update order state to cancelled
        await client.query(`
            UPDATE public.orders
            SET status = 'cancelled',
                escrow_state = $1,
                updated_at = NOW()
            WHERE id = $2;
        `, [newEscrowState, orderId]);

        // 4. Record cancellation in audit log table
        await client.query(`
            INSERT INTO public.order_cancellations (order_id, reason, refund_status, amount_refunded)
            VALUES ($1, $2, $3, $4);
        `, [
            orderId, 
            reason || 'User requested cancellation', 
            refundAction, 
            parseFloat(order.total_payable || 0)
        ]);

        // 5. Free up assigned rider if order was already in transit
        if (order.rider_id) {
            await client.query(`
                UPDATE public.riders
                SET is_available = true,
                    updated_at = NOW()
                WHERE id = $1;
            `, [order.rider_id]);
        }

        await client.query('COMMIT');

        logger.info(`[Order Cancelled] Order #${orderId} cancelled. Refund Status: ${refundAction} (KES ${order.total_payable})`);

        res.status(200).json({
            success: true,
            message: `Order #${orderId} cancelled successfully.`,
            refundDetails: {
                orderId: parseInt(orderId),
                amountRefundedKES: parseFloat(order.total_payable || 0),
                refundStatus: refundAction
            }
        });

    } catch (error) {
        // Guarantee database rollback for both operational AppErrors and syntax/connection failures
        await client.query('ROLLBACK');
        throw error;
    } finally {
        // Always release connection back to pool
        client.release();
    }
});