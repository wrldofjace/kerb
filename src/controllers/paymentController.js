const asyncHandler = require('express-async-handler');
const db = require('../config/db');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');
const { sendDeliveryOtpSms } = require('../services/smsServices');
const mpesaService = require('../services/mpesaService');

/**
 * @desc    Initiate M-Pesa STK Push Prompt on Customer's Phone
 * @route   POST /api/payments/stk-push
 * @access  Private
 */
exports.initiateStkPush = asyncHandler(async (req, res) => {
    let { orderId, phoneNumber, amount } = req.body;

    // Fallback lookup: if phoneNumber or amount is missing, fetch from orders table
    if ((!phoneNumber || !amount) && orderId) {
        const orderResult = await db.query(
            `SELECT total_amount, buyer_phone, customer_phone 
             FROM public.orders 
             WHERE id = $1 
             LIMIT 1`,
            [orderId]
        );

        if (orderResult.rows.length === 0) {
            throw new AppError(`Order #${orderId} not found for payment processing`, 404);
        }

        const order = orderResult.rows[0];
        amount = amount || order.total_amount;
        phoneNumber = phoneNumber || order.buyer_phone || order.customer_phone;
    }

    if (!phoneNumber || !amount) {
        throw new AppError('Phone number and payment amount are required to trigger STK Push', 400);
    }

    const response = await mpesaService.initiateStkPush(phoneNumber, amount, orderId || '0');

    // Save CheckoutRequestID back to the order record if orderId is available
    if (orderId && response.CheckoutRequestID) {
        await db.query(
            `UPDATE public.orders 
             SET mpesa_checkout_request_id = $1 
             WHERE id = $2`,
            [response.CheckoutRequestID, orderId]
        );
    }

    res.status(200).json({
        status: 'success',
        message: 'STK Push prompt initiated on customer device',
        checkoutRequestId: response.CheckoutRequestID,
        merchantRequestId: response.MerchantRequestID,
        customerMessage: response.CustomerMessage
    });
});

/**
 * @desc    M-Pesa STK Push Webhook Callback Handler
 * @route   POST /api/payments/mpesa-callback
 * @access  Public (Safaricom Webhook)
 */
exports.mpesaCallback = asyncHandler(async (req, res) => {
    const { Body } = req.body || {};

    if (!Body || !Body.stkCallback) {
        logger.warn('[M-Pesa Webhook] Invalid structural payload received');
        return res.status(200).json({ ResultCode: 1, ResultDesc: 'Invalid structural payload mapping' });
    }

    const { ResultCode, ResultDesc, CheckoutRequestID, CallbackMetadata } = Body.stkCallback;
    const client = await db.getClient();

    try {
        if (ResultCode === 0) {
            const metadataItems = CallbackMetadata?.Item || [];
            const mpesaReceipt = metadataItems.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
            const rawPhone = metadataItems.find(item => item.Name === 'PhoneNumber')?.Value;
            const customerPhone = rawPhone ? `+${rawPhone}` : null;

            await client.query('BEGIN');

            // 1. Lock exact order tied to this M-Pesa CheckoutRequestID
            const fetchOrderQuery = `
                SELECT o.id, o.shop_id, o.delivery_fee, o.status, o.delivery_otp, s.shop_name
                FROM public.orders o
                LEFT JOIN public.shops s ON o.shop_id = s.id
                WHERE o.mpesa_checkout_request_id = $1 AND o.status = 'pending_payment'
                FOR UPDATE;
            `;

            // Fallback: If CheckoutRequestID isn't stored, match latest pending_payment order
            const fallbackQuery = `
                SELECT o.id, o.shop_id, o.delivery_fee, o.status, o.delivery_otp, s.shop_name
                FROM public.orders o
                LEFT JOIN public.shops s ON o.shop_id = s.id
                WHERE o.status = 'pending_payment'
                ORDER BY o.created_at DESC
                LIMIT 1
                FOR UPDATE;
            `;

            let orderResult = await client.query(fetchOrderQuery, [CheckoutRequestID]);

            if (orderResult.rows.length === 0) {
                orderResult = await client.query(fallbackQuery);
            }

            if (orderResult.rows.length > 0) {
                const orderData = orderResult.rows[0];
                const deliveryFee = parseFloat(orderData.delivery_fee || 150);
                const shopName = orderData.shop_name || 'Merchant Shop';

                // Reuse existing delivery OTP from checkout or generate new 4-digit code
                const finalDeliveryOtp = orderData.delivery_otp || Math.floor(1000 + Math.random() * 9000).toString();

                const platformCut = Math.round(deliveryFee * 0.15);
                const riderShare = deliveryFee - platformCut;

                const updateOrderQuery = `
                    UPDATE public.orders 
                    SET status = 'escrow_held', 
                        escrow_state = 'held', 
                        mpesa_receipt_number = $1, 
                        buyer_phone = COALESCE($2, buyer_phone),
                        delivery_otp = $3,
                        platform_commission = $4,
                        final_payout_amount = $5,
                        updated_at = NOW()
                    WHERE id = $6 AND status = 'pending_payment';
                `;

                await client.query(updateOrderQuery, [
                    mpesaReceipt, 
                    customerPhone, 
                    finalDeliveryOtp, 
                    platformCut, 
                    riderShare, 
                    orderData.id
                ]);

                await client.query('COMMIT');

                logger.info(`[Vault Locked] Escrow Held for Order #${orderData.id}. Receipt: ${mpesaReceipt}. OTP: ${finalDeliveryOtp}`);

                // Dispatch SMS OTP code to customer asynchronously
                if (customerPhone) {
                    sendDeliveryOtpSms(customerPhone, finalDeliveryOtp, shopName).catch(err => 
                        logger.error(`[SMS Gateway Error] Failed to send OTP for Order #${orderData.id}: ${err.message}`)
                    );
                }
            } else {
                await client.query('ROLLBACK');
                logger.warn(`[M-Pesa Webhook] Received clearance for CheckoutRequestID '${CheckoutRequestID}', but no matching 'pending_payment' order was found.`);
            }
        } else {
            logger.warn(`[M-Pesa Rejected] Transaction canceled or failed on handset: ${ResultDesc} (Code ${ResultCode})`);
        }

        return res.status(200).json({ ResultCode: 0, ResultDesc: 'Callback processed successfully' });
    } catch (error) {
        await client.query('ROLLBACK');
        logger.error(`[M-Pesa Webhook Processing Error]: ${error.message}`);
        return res.status(200).json({ ResultCode: 0, ResultDesc: 'Callback error handled gracefully' });
    } finally {
        client.release();
    }
});

/**
 * @desc    Manual or system release of escrow funds upon delivery OTP verification
 * @route   POST /api/payments/release-escrow
 * @access  Private (Admin / Rider)
 */
exports.releaseEscrow = asyncHandler(async (req, res) => {
    const { orderId, otpCode } = req.body;

    if (!orderId || !otpCode) {
        throw new AppError('Missing required parameters: orderId or otpCode', 400);
    }

    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        const orderCheck = await client.query(
            `SELECT id, shop_id, total_amount, delivery_fee, delivery_otp, escrow_state
             FROM public.orders
             WHERE id = $1 
             FOR UPDATE`,
            [orderId]
        );

        if (orderCheck.rows.length === 0) {
            throw new AppError('Order not found', 404);
        }

        const order = orderCheck.rows[0];

        if (order.escrow_state !== 'held') {
            throw new AppError(`Cannot release funds. Current escrow state is '${order.escrow_state}', expected 'held'.`, 400);
        }

        if (String(order.delivery_otp).trim() !== String(otpCode).trim()) {
            throw new AppError('Invalid delivery OTP code. Verification failed.', 401);
        }

        // 1. Mark order escrow as released and status completed
        await client.query(
            `UPDATE public.orders
             SET escrow_state = 'released',
                 status = 'completed',
                 updated_at = NOW()
             WHERE id = $1`,
            [orderId]
        );

        // 2. Credit clearable balance to vendor (Total Order Amount minus delivery fee)
        const vendorEarning = parseFloat(order.total_amount) - parseFloat(order.delivery_fee || 0);
        if (order.shop_id && vendorEarning > 0) {
            await client.query(
                `UPDATE public.shops
                 SET balance = balance + $1,
                     updated_at = NOW()
                 WHERE id = $2`,
                [vendorEarning, order.shop_id]
            );
        }

        await client.query('COMMIT');
        logger.info(`[Escrow Released] Order #${orderId} completed successfully. Vendor credited: KES ${vendorEarning}`);

        res.status(200).json({
            status: 'success',
            message: 'Escrow funds successfully released to vendor.',
            orderId: parseInt(orderId),
            status: 'completed',
            escrowState: 'released'
        });

    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
});

/**
 * @desc    M-Pesa B2C (Business to Customer) Payout Webhook Callback
 * @route   POST /api/payments/mpesa-b2c-callback
 * @access  Public (Safaricom Webhook)
 */
exports.mpesaB2cCallback = asyncHandler(async (req, res) => {
    const { Result } = req.body || {};

    if (!Result) {
        logger.warn('[M-Pesa B2C Webhook] Invalid B2C payload structure received');
        return res.status(200).json({ ResultCode: 1, ResultDesc: 'Invalid B2C payload structure' });
    }

    const { ResultCode, ResultDesc, OriginatorConversationID, TransactionID } = Result;
    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        if (ResultCode === 0) {
            logger.info(`[B2C Payout Settled] ConvID: ${OriginatorConversationID} | Receipt: ${TransactionID}`);

            await client.query(
                `UPDATE public.vendor_withdrawals
                 SET status = 'completed',
                     mpesa_receipt = $1,
                     updated_at = NOW()
                 WHERE mpesa_conversation_id = $2 AND status = 'pending'`,
                [TransactionID, OriginatorConversationID]
            );
        } else {
            logger.warn(`[B2C Payout Failed] ConvID: ${OriginatorConversationID} | Code: ${ResultCode} - ${ResultDesc}`);

            // Find pending withdrawal to revert vendor balance on failure
            const withdrawalResult = await client.query(
                `SELECT shop_id, amount 
                 FROM public.vendor_withdrawals 
                 WHERE mpesa_conversation_id = $1 AND status = 'pending'
                 FOR UPDATE`,
                [OriginatorConversationID]
            );

            if (withdrawalResult.rows.length > 0) {
                const { shop_id, amount } = withdrawalResult.rows[0];

                // Refund balance back to vendor shop account
                await client.query(
                    `UPDATE public.shops 
                     SET balance = balance + $1 
                     WHERE id = $2`,
                    [amount, shop_id]
                );

                await client.query(
                    `UPDATE public.vendor_withdrawals
                     SET status = 'failed',
                         updated_at = NOW()
                     WHERE mpesa_conversation_id = $1`,
                    [OriginatorConversationID]
                );
            }
        }

        await client.query('COMMIT');
        return res.status(200).json({ ResultCode: 0, ResultDesc: 'B2C Callback processed successfully' });
    } catch (error) {
        await client.query('ROLLBACK');
        logger.error(`[B2C Callback Processing Error]: ${error.message}`);
        return res.status(200).json({ ResultCode: 0, ResultDesc: 'Error handled gracefully' });
    } finally {
        client.release();
    }
});