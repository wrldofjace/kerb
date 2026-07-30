const rateLimit = require('express-rate-limit');

// 1. STRICT LIMITER FOR OTP VERIFICATION (Brute-force protection for 4-digit OTPs)
const otpRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Limit each IP to 5 OTP attempts per window
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: 'Too many OTP verification attempts. Please try again after 15 minutes.'
    }
});

// 2. CHECKOUT RATE LIMITER (Prevents automated order spamming)
const checkoutRateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 20, // Limit each IP to 20 checkout requests per hour
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: 'Checkout request limit exceeded. Please try again later.'
    }
});

// 3. GENERAL API LIMITER
const generalRateLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute
    standardHeaders: true,
    legacyHeaders: false
});

module.exports = {
    otpRateLimiter,
    checkoutRateLimiter,
    generalRateLimiter
};