const NodeRSA = require('node-rsa');
const logger = require('./logger');
const { AppError } = require('../middleware/errorHandler');

// Resolve CommonJS / ESM export compatibility for node-rsa
const RSA = typeof NodeRSA === 'function' ? NodeRSA : NodeRSA.default || Object.values(NodeRSA)[0];

// Default Safaricom Sandbox RSA Public Key
const SANDBOX_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Z3VS5JJcds3s4bJCVDV
4EhMW+svY2d4d0eFyaL0EoT/8WYzYCa7I0scjmBv3h4F0dW89xhjCmCg2Hs0K6yL
IbWyPKgn5qO+8lfb1xLQr3xZNwf3rZTZe9RqGZPL5POL3sXFqWbDlVh1rU1iEr6z
eNrVUq/g2QjL43oeajEhLEHxKvBXXzs6WbGRfjP5lJBdR0TN3BZ6hVHLB9W4FmVb
9PD4VEKhsQCE7sHEWfv1dqCqHqbFWDFM0qVCCK6+u5GhMf2xj5oNjSRBHp6fHHNc
YwQWPvSaRR4jKsFEWnfCm76FV6FS0QRXE8pBnT5Cgu85l9ZBGxIw1W44F8v0FVqe
7QIDAQAB
-----END PUBLIC KEY-----`;

/**
 * Encrypts the M-Pesa B2C Initiator Password using Safaricom's RSA Public Key (PKCS1 v1.5).
 * 
 * @param {string} password - The raw initiator password (e.g. process.env.MPESA_B2C_INITIATOR_PASSWORD)
 * @returns {string} Base64 encoded RSA encrypted security credential
 */
function encryptPassword(password) {
    if (!password) {
        logger.error('[M-Pesa Encryption Error] Missing required parameter: password');
        throw new AppError('Initiator password is required for B2C credential encryption', 400);
    }

    try {
        // Use environment public key if present (for production), otherwise fall back to Sandbox key
        const rawKey = process.env.MPESA_PUBLIC_KEY || SANDBOX_PUBLIC_KEY;
        const formattedPublicKey = rawKey.replace(/\\n/g, '\n').trim();

        const key = new RSA(formattedPublicKey);
        
        // Safaricom Daraja requires PKCS #1 v1.5 padding
        key.setOptions({ encryptionScheme: 'pkcs1' });

        const encryptedCredential = key.encrypt(Buffer.from(password), 'base64');
        return encryptedCredential;
    } catch (error) {
        logger.error(`[M-Pesa Encryption Error] Failed during RSA key processing: ${error.message}`);
        throw new AppError(`Failed to encrypt B2C initiator password: ${error.message}`, 500);
    }
}

module.exports = {
    encryptPassword
};