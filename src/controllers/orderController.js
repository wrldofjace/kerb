const asyncHandler = require('express-async-handler');
const db = require('../config/db');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');
const { calculateHaversineDistance, calculateDeliveryFee } = require('../utils/distanceCalculator');

// Optional: Import M-Pesa STK Push service when active
// const { initiateStkPush } = require('../services/mpesaService');

/**
 * @desc    Create order, calculate distance/fee, generate delivery OTP, and initiate STK payment
 * @route   POST /api/orders/checkout
 * @access  Private (Buyer)
 */
exports.createOrderAndPay = asyncHandler(async (req, res) => {
    const { shopId, customerId, itemTotal, lng, lat, phoneNumber } = req.body;

    // 1. Validate request parameters
    if (!shopId || !customerId || itemTotal === undefined || lng === undefined || lat === undefined) {
        throw new AppError('Missing required checkout parameters: shopId, customerId, itemTotal, lng, lat', 400);
    }

    const buyerLat = parseFloat(lat);
    const buyerLng = parseFloat(lng);
    const productCost = parseFloat(itemTotal);

    if (isNaN(buyerLat) || isNaN(buyerLng) || isNaN(productCost) || productCost <= 0) {
        throw new AppError('Invalid numerical values provided for location coordinates or product cost.', 400);
    }

    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        // 2. Fetch Shop coordinates
        const shopQuery = `
            SELECT id, shop_name, latitude, longitude 
            FROM public.shops 
            WHERE id = $1;
        `;
        const shopResult = await client.query(shopQuery, [shopId]);

        if (shopResult.rowCount === 0) {
            throw new AppError('Shop not found', 404);
        }

        const shop = shopResult.rows[0];
        const shopLat = parseFloat(shop.latitude);
        const shopLng = parseFloat(shop.longitude);

        // 3. Calculate Haversine distance & delivery fee
        const distanceKm = calculateHaversineDistance(buyerLat, buyerLng, shopLat, shopLng);
        const deliveryFee = calculateDeliveryFee(distanceKm);

        // 4. Generate 4-digit Delivery OTP (1000 - 9999)
        const generatedOtp = Math.floor(1000 + Math.random() * 9000).toString();

        // 5. Insert Order into DB using GEOGRAPHY type for spatial queries (ST_MakePoint takes lon, lat)
        const insertOrderQuery = `
            INSERT INTO public.orders (
                shop_id, 
                buyer_id, 
                product_cost, 
                delivery_fee, 
                escrow_state, 
                status,
                delivery_location,
                delivery_otp
            )
            VALUES ($1, $2, $3, $4, 'held', 'pending_payment', ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, $7)
            RETURNING id, product_cost, delivery_fee, total_amount, escrow_state, status, delivery_otp, created_at;
        `;

        const orderResult = await client.query(insertOrderQuery, [
            shopId,
            customerId,   // buyer_id
            productCost,  // product_cost
            deliveryFee,  // delivery_fee
            buyerLng,     // X (lon)
            buyerLat,     // Y (lat)
            generatedOtp
        ]);

        const newOrder = orderResult.rows[0];

        // 6. Initiate STK Push & Save CheckoutRequestID (if phone provided)
        let checkoutRequestId = null;

        if (phoneNumber) {
            try {
                /*
                const stkResponse = await initiateStkPush({
                    phoneNumber: phoneNumber,
                    amount: Math.ceil(parseFloat(newOrder.total_amount)),
                    accountReference: `ORDER_${newOrder.id}`,
                    transactionDesc: `Order #${newOrder.id} payment`
                });

                checkoutRequestId = stkResponse?.data?.CheckoutRequestID || stkResponse?.CheckoutRequestID;
                */

                if (checkoutRequestId) {
                    await client.query(`
                        UPDATE public.orders 
                        SET mpesa_checkout_request_id = $1 
                        WHERE id = $2;
                    `, [checkoutRequestId, newOrder.id]);

                    logger.info(`[M-Pesa STK] Order #${newOrder.id} linked with CheckoutRequestID: ${checkoutRequestId}`);
                }
            } catch (stkErr) {
                logger.error(`[M-Pesa STK Failure] Order #${newOrder.id} STK push failed: ${stkErr.message}`);
                // Proceed so order record is retained in pending_payment state for manual re-try
            }
        }

        await client.query('COMMIT');

        logger.info(`[Order Created] Order #${newOrder.id} created. Distance: ${distanceKm.toFixed(2)}km. Total: KES ${newOrder.total_amount}`);

        res.status(201).json({
            success: true,
            orderId: newOrder.id,
            metrics: {
                distance_km: parseFloat(distanceKm.toFixed(2)),
                delivery_fee: parseFloat(newOrder.delivery_fee),
                product_cost: parseFloat(newOrder.product_cost),
                total_payable: parseFloat(newOrder.total_amount)
            },
            escrow_state: newOrder.escrow_state,
            status: newOrder.status,
            delivery_otp: newOrder.delivery_otp,
            checkout_request_id: checkoutRequestId,
            created_at: newOrder.created_at
        });

    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
});

/**
 * @desc    Get order by ID with extracted latitude & longitude coordinates
 * @route   GET /api/orders/:id
 * @access  Private
 */
exports.getOrderById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!id) {
        throw new AppError('Missing required parameter: id', 400);
    }

    const query = `
        SELECT 
            o.id, 
            o.shop_id, 
            o.buyer_id, 
            o.rider_id, 
            o.product_cost, 
            o.delivery_fee, 
            o.total_amount, 
            o.platform_commission,
            o.final_payout_amount,
            o.status, 
            o.escrow_state, 
            o.delivery_otp,
            o.mpesa_checkout_request_id,
            o.mpesa_receipt_number,
            ST_Y(o.delivery_location::geometry) AS buyer_latitude,
            ST_X(o.delivery_location::geometry) AS buyer_longitude,
            o.created_at,
            o.updated_at
        FROM public.orders o
        WHERE o.id = $1;
    `;

    const result = await db.query(query, [id]);

    if (result.rows.length === 0) {
        throw new AppError('Order not found', 404);
    }

    const order = result.rows[0];

    res.status(200).json({
        success: true,
        order: {
            ...order,
            product_cost: parseFloat(order.product_cost),
            delivery_fee: parseFloat(order.delivery_fee),
            total_amount: parseFloat(order.total_amount),
            platform_commission: order.platform_commission ? parseFloat(order.platform_commission) : 0,
            final_payout_amount: order.final_payout_amount ? parseFloat(order.final_payout_amount) : 0,
            location: {
                latitude: parseFloat(order.buyer_latitude),
                longitude: parseFloat(order.buyer_longitude)
            }
        }
    });
});