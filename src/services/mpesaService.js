const axios = require('axios');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');
const { encryptPassword } = require('../utils/mpesaEncryption');

// Environment-aware Base URL (defaults to Sandbox if MPESA_ENV isn't 'production')
const MPESA_BASE_URL = process.env.MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

/**
 * Clean & Format Phone Number to Standard 254XXXXXXXXX Format
 * Handles: "0712345678", "0112345678", "+254712345678", "254712345678"
 *
 * @param {string|number} phone
 * @returns {string} Formatted phone number starting with 254
 */
const formatPhoneNumber = (phone) => {
    if (!phone) {
        throw new AppError('Phone number parameter is required for formatting', 400);
    }

    let clean = phone.toString().replace(/\D/g, ''); // Strip non-numeric characters

    if (clean.startsWith('0')) {
        clean = `254${clean.slice(1)}`;
    } else if (clean.startsWith('7') || clean.startsWith('1')) {
        clean = `254${clean}`;
    }

    if (!/^254(7|1)\d{8}$/.test(clean)) {
        logger.warn(`[M-Pesa Phone Validation] Invalid phone format detected: ${phone}`);
        throw new AppError(`Invalid Safaricom phone number format: ${phone}`, 400);
    }

    return clean;
};

/**
 * Generate Safaricom OAuth Access Token using Consumer Key & Secret
 *
 * @returns {Promise<string>} OAuth Access Token
 */
const getMpesaToken = async () => {
    const consumerKey = process.env.MPESA_CONSUMER_KEY?.trim();
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET?.trim();

    if (!consumerKey || !consumerSecret) {
        logger.error('[M-Pesa Token Error] Missing MPESA_CONSUMER_KEY or MPESA_CONSUMER_SECRET in process.env');
        throw new AppError('M-Pesa configuration error: Consumer credentials missing', 500);
    }

    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

    try {
        const response = await axios.get(
            `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
            {
                headers: {
                    Authorization: `Basic ${auth}`
                },
                timeout: 10000 // 10s timeout
            }
        );

        return response.data.access_token;
    } catch (error) {
        const darajaMessage = error.response?.data?.errorMessage || error.message;
        logger.error(`[M-Pesa Token Error] Authentication failed: ${darajaMessage}`);
        throw new AppError(`Failed to authenticate with Safaricom Daraja API: ${darajaMessage}`, 500);
    }
};

/**
 * Trigger STK Push (Lipa Na M-Pesa Online / C2B Express Prompt)
 *
 * @param {string|number} phoneNumber - Customer M-Pesa phone number
 * @param {number|string} amount - Amount in KES to charge
 * @param {string|number} orderId - Order reference ID
 * @returns {Promise<Object>} Daraja STK Push API response object
 */
const initiateStkPush = async (phoneNumber, amount, orderId) => {
    if (!phoneNumber || !amount || !orderId) {
        throw new AppError('Missing required STK push parameters (phoneNumber, amount, orderId)', 400);
    }

    const passkey = process.env.MPESA_PASSKEY?.trim();
    const callbackUrl = process.env.MPESA_CALLBACK_URL?.trim();
    const shortcode = process.env.MPESA_SHORTCODE?.trim() || '174379';

    if (!passkey || !callbackUrl) {
        logger.error('[STK Push Config Error] Missing MPESA_PASSKEY or MPESA_CALLBACK_URL');
        throw new AppError('M-Pesa configuration error: Passkey or Callback URL missing', 500);
    }

    try {
        const token = await getMpesaToken();
        const formattedPhone = formatPhoneNumber(phoneNumber);

        // Format Timestamp: YYYYMMDDHHmmss
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        
        // Passkey Base64 Hash
        const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

        const requestBody = {
            BusinessShortCode: shortcode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: 'CustomerPayBillOnline',
            Amount: Math.ceil(parseFloat(amount)),
            PartyA: formattedPhone,
            PartyB: shortcode,
            PhoneNumber: formattedPhone,
            CallBackURL: callbackUrl,
            AccountReference: `Order-${orderId}`,
            TransactionDesc: `Escrow Payment Order #${orderId}`
        };

        const response = await axios.post(
            `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
            requestBody,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );

        logger.info(`[STK Push Initiated] Order ID: ${orderId} | CheckoutRequestID: ${response.data.CheckoutRequestID}`);
        return response.data;
    } catch (error) {
        const darajaError = error.response?.data?.errorMessage || error.response?.data?.CustomerMessage || error.message;
        logger.error(`[STK Push Execution Error] Order ID ${orderId}: ${darajaError}`);
        throw new AppError(`M-Pesa STK Push initialization failed: ${darajaError}`, 500);
    }
};

/**
 * Initiate M-Pesa B2C Payout (Vendor Withdrawal / Rider Payment)
 *
 * @param {string|number} phoneNumber - Recipient phone number
 * @param {number|string} amount - Amount in KES to disburse
 * @param {string} remarks - Payment narrative (e.g., "Vendor Payout Shop #4")
 * @param {string} queueTimeoutUrl - B2C Timeout Webhook Callback URL
 * @param {string} resultUrl - B2C Result Webhook Callback URL
 * @returns {Promise<Object>} Daraja B2C API response object
 */
const initiateB2cPayout = async (phoneNumber, amount, remarks, queueTimeoutUrl, resultUrl) => {
    const initiatorName = process.env.MPESA_INITIATOR_NAME?.trim();
    const rawInitiatorPassword = process.env.MPESA_INITIATOR_PASSWORD?.trim();
    const shortcode = process.env.MPESA_SHORTCODE?.trim();

    if (!initiatorName || !rawInitiatorPassword || !shortcode) {
        logger.error('[B2C Payout Config Error] Missing B2C Initiator credentials in environment variables');
        throw new AppError('M-Pesa B2C configuration error: Credentials missing', 500);
    }

    try {
        const token = await getMpesaToken();
        const formattedPhone = formatPhoneNumber(phoneNumber);
        const securityCredential = encryptPassword(rawInitiatorPassword);

        const requestBody = {
            InitiatorName: initiatorName,
            SecurityCredential: securityCredential,
            CommandID: 'BusinessPayment', // Options: SalaryPayment, BusinessPayment, PromotionPayment
            Amount: Math.floor(parseFloat(amount)),
            PartyA: shortcode,
            PartyB: formattedPhone,
            Remarks: remarks || 'Vendor Balance Withdrawal',
            QueueTimeOutURL: queueTimeoutUrl || process.env.MPESA_B2C_TIMEOUT_URL,
            ResultURL: resultUrl || process.env.MPESA_B2C_RESULT_URL,
            Occasion: 'Payout'
        };

        const response = await axios.post(
            `${MPESA_BASE_URL}/mpesa/b2c/v1/paymentrequest`,
            requestBody,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 20000
            }
        );

        logger.info(`[B2C Payout Triggered] Recipient: ${formattedPhone} | ConversationID: ${response.data.ConversationID}`);
        return response.data;
    } catch (error) {
        const darajaError = error.response?.data?.errorMessage || error.message;
        logger.error(`[B2C Payout Error] Phone: ${phoneNumber} | Amount: ${amount} | Error: ${darajaError}`);
        throw new AppError(`M-Pesa B2C Payout failed: ${darajaError}`, 500);
    }
};

module.exports = {
    getMpesaToken,
    formatPhoneNumber,
    initiateStkPush,
    initiateB2cPayout
};