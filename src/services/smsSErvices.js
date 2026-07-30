const admin = require('firebase-admin');

// 1. Environment credentials with sandbox fallback
const credentials = {
    apiKey: process.env.AT_API_KEY?.trim(),
    username: process.env.AT_USERNAME?.trim() || 'sandbox'
};

// Initialize Africa's Talking SDK
const AfricasTalking = require('africastalking')(credentials);
const sms = AfricasTalking.SMS;

// 2. Initialize Firebase Admin SDK (Optional)
let firebaseInitialized = false;
if (process.env.FIREBASE_CREDENTIALS) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        firebaseInitialized = true;
        console.log('✅ Firebase Admin SDK initialized successfully');
    } catch (err) {
        console.warn('⚠️ [Firebase Init Warning]: Invalid FIREBASE_CREDENTIALS in .env:', err.message);
    }
}

/**
 * Format phone numbers to Africa's Talking +254... standard
 */
const formatPhoneNumber = (phone) => {
    let clean = phone.toString().replace(/\D/g, ''); // Strip non-numeric chars
    if (clean.startsWith('0')) {
        clean = `254${clean.slice(1)}`;
    } else if (clean.startsWith('7') || clean.startsWith('1')) {
        clean = `254${clean}`;
    }
    return `+${clean}`;
};

/**
 * Dispatches a delivery verification OTP code via SMS
 */
const sendDeliveryOtpSms = async (toPhoneNumber, otpCode, shopName, customerName = 'Customer', riderName = 'your rider') => {
    if (!toPhoneNumber || !otpCode) {
        console.error("[SMS Error] Missing required parameters (toPhoneNumber or otpCode)");
        return null;
    }

    try {
        const formattedPhone = formatPhoneNumber(toPhoneNumber);

        const options = {
            to: [formattedPhone],
            message: `Hi ${customerName}, your payment for ${shopName || 'your order'} is secured! Show Code ${otpCode} to ${riderName} upon delivery to release your order.`
        };

        if (process.env.AT_SENDER_ID) {
            options.from = process.env.AT_SENDER_ID;
        }

        const result = await sms.send(options);
        const recipientStatus = result?.SMSMessageData?.Recipients?.[0]?.status || 'Unknown';
        
        console.log(`[SMS Gateway] OTP sent to ${formattedPhone}. Status: ${recipientStatus}`);
        return result;
    } catch (error) {
        console.error("[SMS Error] Delivery pipeline failure:", error.message);
        return null;
    }
};

/**
 * Send FCM Push Notification to Mobile App (Safely skips if Firebase isn't configured)
 */
const sendPushNotification = async (fcmToken, title, body, data = {}) => {
    if (!firebaseInitialized || !fcmToken) return null;
    
    try {
        const message = {
            notification: { title, body },
            data,
            token: fcmToken
        };
        const response = await admin.messaging().send(message);
        console.log('🔔 [Push Sent]:', response);
        return response;
    } catch (error) {
        console.error('❌ [Push Error]:', error.message);
        return null;
    }
};

module.exports = { 
    sendDeliveryOtpSms,
    sendPushNotification,
    formatPhoneNumber 
};