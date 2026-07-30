const axios = require('axios');
const asyncHandler = require('express-async-handler');
const db = require('../config/db');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');
const { encryptPassword } = require('../utils/mpesaEncryption');

const AfricasTalking = require('africastalking')({
    apiKey: process.env.AT_API_KEY,
    username: process.env.AT_USERNAME || 'sandbox'
});

/**
 * Helper: Send SMS via Africa's Talking
 */
async function sendPayoutSuccessSms(phoneNumber, amount, receiptNumber) {
    try {
        const sms = AfricasTalking.SMS;
        const message = `Payout Successful! KES ${amount} has been deposited to your M-Pesa account. Receipt: ${receiptNumber}. Thank you for partnering with us!`;

        let formattedRecipient = phoneNumber.toString().trim();
        if (!formattedRecipient.startsWith('+')) {
            formattedRecipient = `+${formattedRecipient}`;
        }

        const response = await sms.send({
            to: [formattedRecipient],
            message: message
        });

        logger.info(`[SMS Sent] Notification sent to ${formattedRecipient}: ${response.SMSMessageData?.Recipients[0]?.status}`);
    } catch (smsError) {
        logger.error(`[SMS Error] Engine failed to dispatch SMS: ${smsError.message}`);
    }
}

/**
 * Helper: Obtain M-Pesa OAuth Access Token
 */
async function getMpesaToken() {
    try {
        const consumerKey = process.env.MPESA_CONSUMER_KEY?.trim();
        const consumerSecret = process.env.MPESA_CONSUMER_SECRET?.trim();

        if (!consumerKey || !consumerSecret) {
            throw new AppError('Missing M-Pesa consumer credentials (MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET are required)', 500);
        }

        const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

        const response = await axios.get(
            'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
            { headers: { Authorization: `Basic ${auth}` } }
        );

        return response.data.access_token;
    } catch (tokenError) {
        logger.error(`[M-Pesa Auth Error] Token Generation Failed: ${tokenError.response?.data || tokenError.message}`);
        throw new AppError('Failed to authenticate with M-Pesa gateway', 502);
    }
}

/**
 * @desc    Get clearable earnings balance for a vendor/shop
 * @route   GET /api/vendors/:shopId/balance
 * @access  Private (Vendor / Admin)
 */
exports.getVendorBalance = asyncHandler(async (req, res) => {
    const { shopId } = req.params;

    if (!shopId) {
        throw new AppError('Missing required parameter: shopId', 400);
    }

    // Query total earnings from completed orders where escrow is released
    const earningsQuery = `
        SELECT COALESCE(SUM(final_payout_amount), 0) AS total_earned
        FROM public.orders
        WHERE shop_id = $1 AND escrow_state = 'released';
    `;

    const earningsResult = await db.query(earningsQuery, [shopId]);
    const totalEarned = parseFloat(earningsResult.rows[0].total_earned) || 0;

    // Query total withdrawn/pending payout records
    const withdrawalsQuery = `
        SELECT COALESCE(SUM(amount), 0) AS total_withdrawn
        FROM public.vendor_withdrawals
        WHERE shop_id = $1 AND status IN ('completed', 'pending');
    `;

    const withdrawalsResult = await db.query(withdrawalsQuery, [shopId]);
    const totalWithdrawn = parseFloat(withdrawalsResult.rows[0].total_withdrawn) || 0;

    const clearableBalance = totalEarned - totalWithdrawn;

    res.status(200).json({
        success: true,
        shop_id: parseInt(shopId),
        metrics: {
            total_earned: totalEarned,
            total_withdrawn: totalWithdrawn,
            clearable_balance: Math.max(0, clearableBalance)
        }
    });
});

/**
 * @desc    Request M-Pesa B2C Vendor Payout
 * @route   POST /api/vendors/payout
 * @access  Private (Vendor)
 */
exports.requestPayout = asyncHandler(async (req, res) => {
    const { shopId, amount, phoneNumber } = req.body;

    if (!shopId || amount == null || !phoneNumber) {
        throw new AppError('Missing required parameters: shopId, amount, or phoneNumber', 400);
    }

    const payoutAmount = Number(amount);
    if (!Number.isFinite(payoutAmount) || payoutAmount <= 0) {
        throw new AppError('Invalid payout amount provided', 400);
    }

    // Format phone number to 254XXXXXXXXX standard
    let cleanPhone = phoneNumber.toString().replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) {
        cleanPhone = `254${cleanPhone.slice(1)}`;
    } else if (cleanPhone.startsWith('7') || cleanPhone.startsWith('1')) {
        cleanPhone = `254${cleanPhone}`;
    }

    const client = await db.getClient();
    let withdrawalId;

    try {
        await client.query('BEGIN');

        // 1. Verify available earnings vs existing withdrawals inside locked block
        const earningsRes = await client.query(
            `SELECT COALESCE(SUM(final_payout_amount), 0) AS total_earned
             FROM public.orders
             WHERE shop_id = $1 AND escrow_state = 'released'`,
            [shopId]
        );

        const withdrawalsRes = await client.query(
            `SELECT COALESCE(SUM(amount), 0) AS total_withdrawn
             FROM public.vendor_withdrawals
             WHERE shop_id = $1 AND status IN ('completed', 'pending')`,
            [shopId]
        );

        const totalEarned = parseFloat(earningsRes.rows[0].total_earned) || 0;
        const totalWithdrawn = parseFloat(withdrawalsRes.rows[0].total_withdrawn) || 0;
        const clearableBalance = totalEarned - totalWithdrawn;

        if (payoutAmount > clearableBalance) {
            throw new AppError(`Inadequate clearable balance. Available: KES ${clearableBalance}`, 400);
        }

        // 2. Reserve the pending withdrawal record
        const insertWithdrawalQuery = `
           INSERT INTO public.vendor_withdrawals (shop_id, amount, phone_number, status)
           VALUES ($1, $2, $3, 'pending') RETURNING id;
        `;

        const withdrawalResult = await client.query(insertWithdrawalQuery, [shopId, payoutAmount, cleanPhone]);
        withdrawalId = withdrawalResult.rows[0].id;

        await client.query('COMMIT');

    } catch (dbError) {
        await client.query('ROLLBACK');
        throw dbError;
    } finally {
        client.release();
    }

    // 3. Initiate external M-Pesa B2C payout request
    try {
        const token = await getMpesaToken();
        const encryptedCredential = encryptPassword(process.env.MPESA_B2C_INITIATOR_PASSWORD);
        const uniqueOriginatorID = `VND_WD_${withdrawalId}_${Date.now().toString().slice(-4)}`;

        const b2cPayload = {
            OriginatorConversationID: uniqueOriginatorID,
            InitiatorName: process.env.MPESA_B2C_INITIATOR_NAME || 'testapi',
            SecurityCredential: encryptedCredential,
            CommandID: 'BusinessPayment',
            Amount: Math.round(payoutAmount),
            PartyA: process.env.MPESA_B2C_SHORTCODE,
            PartyB: cleanPhone,
            Remarks: `Payout for shop #${shopId}`,
            QueueTimeOutURL: process.env.MPESA_B2C_QUEUE_TIMEOUT_URL || 'https://undone-remark-goliath.ngrok-free.dev/api/vendors/payout-timeout',
            ResultURL: process.env.MPESA_B2C_RESULT_URL || 'https://undone-remark-goliath.ngrok-free.dev/api/vendors/payout-callback',
            Occasion: 'VendorEscrowRelease'
        };

        const response = await axios.post(
            'https://sandbox.safaricom.co.ke/mpesa/b2c/v3/paymentrequest',
            b2cPayload,
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );

        const conversationId = response.data.ConversationID || response.data.OriginatorConversationID;

        await db.query(
            `UPDATE public.vendor_withdrawals
             SET mpesa_conversation_id = $1, updated_at = NOW()
             WHERE id = $2`,
            [conversationId, withdrawalId]
        );

        logger.info(`[B2C Payout] Request sent to Daraja. Withdrawal ID: ${withdrawalId}. ConversationID: ${conversationId}`);

        res.status(200).json({
            success: true,
            message: 'Payout request sent to M-Pesa. Awaiting clearance notification.',
            withdrawal_id: withdrawalId,
            conversation_id: conversationId
        });

    } catch (apiError) {
        logger.error(`[B2C API Error] Execution error: ${apiError.response?.data || apiError.message}`);

        // Mark withdrawal as failed on API error so vendor balance isn't locked indefinitely
        if (withdrawalId) {
            await db.query(
                `UPDATE public.vendor_withdrawals SET status = 'failed', updated_at = NOW() WHERE id = $1`,
                [withdrawalId]
            );
        }

        throw new AppError('Failed to process payout via M-Pesa gateway', 502);
    }
});

/**
 * @desc    Handle M-Pesa B2C Payout Webhook Callback
 * @route   POST /api/vendors/payout-callback
 * @access  Public (Safaricom Webhook)
 */
exports.handlePayoutCallback = asyncHandler(async (req, res) => {
    logger.info('[M-Pesa Callback] Processing B2C payout callback from Safaricom...');

    const { Result } = req.body || {};
    if (!Result) {
        return res.status(200).json({ ResultCode: 1, ResultDesc: 'Invalid callback payload structure' });
    }

    const conversationId = Result.ConversationID || Result.OriginatorConversationID;
    const resultCode = Result.ResultCode;
    const finalStatus = resultCode === 0 ? 'completed' : 'failed';

    try {
        let mpesaReceipt = null;
        const parameters = Result.ResultParameters?.ResultParameter || [];

        if (resultCode === 0 && Array.isArray(parameters)) {
            const receiptObj = parameters.find(param => param.Key === 'TransactionID' || param.key === 'TransactionID');
            if (receiptObj) {
                mpesaReceipt = receiptObj.Value || receiptObj.value || null;
            }
        }

        const updateQuery = `
            UPDATE public.vendor_withdrawals
            SET status = $1,
                mpesa_receipt = $2,
                updated_at = NOW()
            WHERE mpesa_conversation_id = $3
            RETURNING id, shop_id, amount, phone_number;
        `;

        const updateResult = await db.query(updateQuery, [finalStatus, mpesaReceipt, conversationId]);

        if (updateResult.rowCount === 0) {
            logger.warn(`[M-Pesa Callback] Callback received for untracked conversationID: ${conversationId}`);
            return res.status(200).json({ ResultCode: 0, ResultDesc: 'Callback received but untracked' });
        }

        const withdrawal = updateResult.rows[0];
        logger.info(`[Ledger Updated] Withdrawal #${withdrawal.id} for Shop #${withdrawal.shop_id} set to [${finalStatus}]. Receipt: ${mpesaReceipt}`);

        if (finalStatus === 'completed' && mpesaReceipt) {
            sendPayoutSuccessSms(withdrawal.phone_number, withdrawal.amount, mpesaReceipt);
        }

        return res.status(200).json({
            ResultCode: 0,
            ResultDesc: 'Success acknowledgment processed by internal ledger'
        });
    } catch (error) {
        logger.error(`[Callback Processing Error]: ${error.message}`);
        return res.status(200).json({ ResultCode: 0, ResultDesc: 'Internal callback processing error' });
    }
});

exports.sendPayoutSuccessSms = sendPayoutSuccessSms;