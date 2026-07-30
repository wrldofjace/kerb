const asyncHandler = require('express-async-handler');
const db = require('../config/db');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');
const { calculateHaversineDistance, calculateDeliveryFee } = require('../utils/distanceCalculator');
const { sendOtpSms, sendPushNotification } = require('../services/notificationService');

/**
 * @desc    Estimate delivery cost using Haversine distance
 * @route   POST /api/delivery/estimate-cost
 * @access  Public
 */
exports.estimateDeliveryCost = asyncHandler(async (req, res) => {
    const { shopId, buyerLatitude, buyerLongitude } = req.body;

    if (!shopId || buyerLatitude === undefined || buyerLongitude === undefined) {
        throw new AppError('Missing required location parameters (shopId, buyerLatitude, buyerLongitude)', 400);
    }

    const shopQuery = `SELECT latitude, longitude, shop_name FROM public.shops WHERE id = $1;`;
    const shopResult = await db.query(shopQuery, [shopId]);

    if (shopResult.rows.length === 0) {
        throw new AppError('Shop not found', 404);
    }

    const shop = shopResult.rows[0];
    const shopLatitude = parseFloat(shop.latitude);
    const shopLongitude = parseFloat(shop.longitude);

    const distanceKm = calculateHaversineDistance(
        shopLatitude,
        shopLongitude,
        parseFloat(buyerLatitude),
        parseFloat(buyerLongitude)
    );

    const finalFee = calculateDeliveryFee(distanceKm);

    res.status(200).json({
        success: true,
        shopName: shop.shop_name,
        metrics: {
            distanceKm: parseFloat(distanceKm.toFixed(2)),
            deliveryFeeKES: finalFee,
            calculateModel: 'Haversine Bracket Pricing'
        }
    });
});

/**
 * @desc    Accept order & assign rider
 * @route   POST /api/delivery/accept
 * @access  Private (Rider)
 */
exports.acceptOrder = asyncHandler(async (req, res) => {
    const { orderId, riderId } = req.body;

    if (!orderId || !riderId) {
        throw new AppError('Missing required orderId or riderId', 400);
    }

    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        const orderQuery = `
            SELECT o.id, o.status, o.rider_id, o.buyer_phone, u.fcm_token 
            FROM public.orders o
            LEFT JOIN public.users u ON o.buyer_id = u.id
            WHERE o.id = $1 
            FOR UPDATE;
        `;
        const orderResult = await client.query(orderQuery, [orderId]);

        if (orderResult.rows.length === 0) {
            throw new AppError('Order not found', 404);
        }

        const order = orderResult.rows[0];

        if (order.rider_id) {
            throw new AppError('Order is already claimed by another rider.', 400);
        }

        await client.query(`
            UPDATE public.orders
            SET rider_id = $1,
                status = 'in_transit',
                updated_at = NOW()
            WHERE id = $2;
        `, [riderId, orderId]);

        await client.query(`
            UPDATE public.riders
            SET is_available = false,
                updated_at = NOW()
            WHERE id = $1;
        `, [riderId]);

        await client.query('COMMIT');

        // 📡 1. Broadcast order status update via Socket.io
        const io = req.app.get('io');
        if (io) {
            io.to(`order:${orderId}`).emit('order_status_updated', {
                orderId: parseInt(orderId),
                status: 'in_transit',
                riderId: parseInt(riderId),
                timestamp: new Date().toISOString()
            });
        }

        // 🔔 2. Send Push & SMS Notification to Buyer
        if (order.fcm_token) {
            sendPushNotification(
                order.fcm_token,
                'Rider Assigned! 🚴‍♂️',
                `Rider #${riderId} has accepted your order #${orderId} and is on the way.`,
                { orderId: String(orderId), status: 'in_transit' }
            );
        }
        if (order.buyer_phone) {
            sendOtpSms(
                order.buyer_phone,
                `Your order #${orderId} has been accepted by Rider #${riderId} and is now in transit.`
            );
        }

        logger.info(`[Order Claimed] Rider #${riderId} accepted Order #${orderId}`);

        res.status(200).json({
            success: true,
            message: `Order #${orderId} accepted successfully by Rider #${riderId}.`,
            orderId: parseInt(orderId),
            riderId: parseInt(riderId),
            status: 'in_transit'
        });

    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
});

/**
 * @desc    Confirm delivery completion by assigned rider
 * @route   POST /api/delivery/confirm
 * @access  Private (Rider)
 */
exports.confirmDelivery = asyncHandler(async (req, res) => {
    const { orderId, riderId } = req.body;

    if (!orderId || !riderId) {
        throw new AppError('Missing required orderId or riderId', 400);
    }

    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        const orderQuery = `
            SELECT o.id, o.status, o.rider_id, o.shop_id, o.escrow_state, o.buyer_phone, u.fcm_token
            FROM public.orders o
            LEFT JOIN public.users u ON o.buyer_id = u.id
            WHERE o.id = $1
            FOR UPDATE;
        `;
        const orderResult = await client.query(orderQuery, [orderId]);

        if (orderResult.rows.length === 0) {
            throw new AppError('Order not found', 404);
        }

        const order = orderResult.rows[0];

        if (parseInt(order.rider_id) !== parseInt(riderId)) {
            throw new AppError('Unauthorized. You are not the assigned rider for this delivery.', 403);
        }

        if (order.status === 'completed' || order.status === 'delivered') {
            throw new AppError('Order has already been marked as delivered.', 400);
        }

        if (order.status !== 'in_transit' && order.status !== 'escrow_held') {
            throw new AppError(`Cannot complete delivery. Order status is '${order.status}'.`, 400);
        }

        await client.query(`
            UPDATE public.orders
            SET status = 'completed', 
                escrow_state = 'released',
                updated_at = NOW()
            WHERE id = $1;
        `, [orderId]);

        await client.query(`
            UPDATE public.riders
            SET is_available = true,
                updated_at = NOW()
            WHERE id = $1;
        `, [riderId]);

        await client.query('COMMIT');

        // 📡 1. Broadcast completion via Socket.io
        const io = req.app.get('io');
        if (io) {
            io.to(`order:${orderId}`).emit('order_status_updated', {
                orderId: parseInt(orderId),
                status: 'completed',
                escrowState: 'released',
                timestamp: new Date().toISOString()
            });
        }

        // 🔔 2. Send Push Notification to Buyer
        if (order.fcm_token) {
            sendPushNotification(
                order.fcm_token,
                'Order Delivered! 🎉',
                `Your order #${orderId} has been successfully delivered. Thank you!`,
                { orderId: String(orderId), status: 'completed' }
            );
        }

        logger.info(`[Delivery Confirmed] Order #${orderId} completed by Rider #${riderId}`);

        res.status(200).json({
            success: true,
            message: 'Delivery confirmed and escrow funds released successfully.',
            orderId: parseInt(orderId),
            status: 'completed',
            escrowState: 'released',
            riderStatus: 'available'
        });

    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
});

/**
 * @desc    Update rider real-time GPS location
 * @route   POST /api/delivery/update-location
 * @access  Private (Rider)
 */
exports.updateRiderLocation = asyncHandler(async (req, res) => {
    const { riderId, orderId, latitude, longitude } = req.body;

    if (!riderId || latitude === undefined || longitude === undefined) {
        throw new AppError('Missing riderId, latitude, or longitude', 400);
    }

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        throw new AppError('Invalid latitude or longitude value range.', 400);
    }

    // PostGIS ST_MakePoint expects (longitude, latitude)
    const updateQuery = `
        UPDATE public.riders
        SET current_location = ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
            updated_at = NOW()
        WHERE id = $3
        RETURNING id, name;
    `;

    const result = await db.query(updateQuery, [lng, lat, riderId]);

    if (result.rows.length === 0) {
        throw new AppError('Rider record not found.', 404);
    }

    // 📡 Broadcast live GPS coordinates to room "order:<orderId>"
    if (orderId) {
        const io = req.app.get('io');
        if (io) {
            io.to(`order:${orderId}`).emit('rider_location_updated', {
                orderId: parseInt(orderId),
                riderId: parseInt(riderId),
                latitude: lat,
                longitude: lng,
                timestamp: new Date().toISOString()
            });
        }
    }

    res.status(200).json({
        success: true,
        message: 'Location updated and broadcasted successfully.',
        riderId: parseInt(riderId),
        coordinates: { latitude: lat, longitude: lng },
        timestamp: new Date()
    });
});

/**
 * @desc    Verify delivery OTP handshake & trigger vendor wallet payout
 * @route   POST /api/delivery/verify-otp
 * @access  Private (Rider)
 */
exports.verifyDeliveryOtp = asyncHandler(async (req, res) => {
    const { orderId, inputOtp, riderId } = req.body;

    if (!orderId || !inputOtp || !riderId) {
        throw new AppError('Missing orderId, inputOtp, or riderId', 400);
    }

    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        // Lock order row
        const orderQuery = `
            SELECT o.id, o.status, o.escrow_state, o.delivery_otp, o.shop_id, 
                   o.product_cost, o.platform_commission, o.final_payout_amount, 
                   u.fcm_token
            FROM public.orders o
            LEFT JOIN public.users u ON o.buyer_id = u.id
            WHERE o.id = $1 
            FOR UPDATE;
        `;
        const orderResult = await client.query(orderQuery, [orderId]);

        if (orderResult.rows.length === 0) {
            throw new AppError('Target order reference not found', 404);
        }

        const order = orderResult.rows[0];

        if (order.escrow_state !== 'held') {
            throw new AppError(`Cannot verify OTP. Escrow state is '${order.escrow_state}', expected 'held'.`, 400);
        }

        if (String(order.delivery_otp).trim() !== String(inputOtp).trim()) {
            throw new AppError('Invalid OTP code supplied. Verification failed.', 401);
        }

        // Update order status & release escrow
        const completeOrderQuery = `
            UPDATE public.orders 
            SET status = 'completed', 
                escrow_state = 'released',
                rider_id = $2,
                updated_at = NOW()
            WHERE id = $1 
            RETURNING id, shop_id, product_cost, platform_commission, final_payout_amount;
        `;
        const executionResult = await client.query(completeOrderQuery, [orderId, riderId]);
        const finalizedData = executionResult.rows[0];

        const productCost = parseFloat(finalizedData.product_cost || 0);
        const shopId = finalizedData.shop_id;

        // Upsert vendor balance
        let newVendorBalance = 0;
        if (shopId && productCost > 0) {
            const walletUpdateQuery = `
                INSERT INTO public.vendor_wallets (shop_id, balance, updated_at)
                VALUES ($1, $2, NOW())
                ON CONFLICT (shop_id) 
                DO UPDATE SET 
                    balance = public.vendor_wallets.balance + EXCLUDED.balance,
                    updated_at = NOW()
                RETURNING balance;
            `;
            const walletResult = await client.query(walletUpdateQuery, [shopId, productCost]);
            newVendorBalance = parseFloat(walletResult.rows[0].balance);

            // Create ledger entry
            await client.query(`
                INSERT INTO public.wallet_ledger (shop_id, order_id, transaction_type, amount, balance_after, description)
                VALUES ($1, $2, 'sale_payout', $3, $4, $5);
            `, [shopId, orderId, productCost, newVendorBalance, `Escrow payout for Order #${orderId}`]);
        }

        // Free rider
        await client.query(`
            UPDATE public.riders
            SET is_available = true,
                updated_at = NOW()
            WHERE id = $1;
        `, [riderId]);

        await client.query('COMMIT');

        // 📡 1. Broadcast OTP verification & escrow release via Socket.io
        const io = req.app.get('io');
        if (io) {
            io.to(`order:${orderId}`).emit('otp_verified_and_completed', {
                orderId: parseInt(orderId),
                status: 'completed',
                escrowState: 'released',
                timestamp: new Date().toISOString()
            });
        }

        // 🔔 2. Send Push Notification to Buyer confirming delivery handshake
        if (order.fcm_token) {
            sendPushNotification(
                order.fcm_token,
                'Handshake Confirmed! ✅',
                `OTP verified for order #${orderId}. Payment released and delivery completed!`,
                { orderId: String(orderId), status: 'completed' }
            );
        }

        logger.info(`[Handshake Verified] Order #${orderId} verified. Vendor #${shopId} balance credited KES ${productCost}`);

        res.status(200).json({
            success: true,
            message: 'Delivery handshake confirmed! Escrow funds released to Rider and Vendor.',
            ledgerSplit: {
                orderId: finalizedData.id,
                shopId: shopId,
                vendorProductEarningsKES: productCost,
                vendorWalletNewBalanceKES: newVendorBalance,
                platformEarningsKES: parseFloat(finalizedData.platform_commission || 0),
                riderPayoutKES: parseFloat(finalizedData.final_payout_amount || 0)
            }
        });

    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
});