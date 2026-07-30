const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();

const paymentController = require('../controllers/paymentController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

/**
 * Helper middleware to handle request validation errors
 */
const validateRequest = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            status: 'fail',
            message: 'Validation failed',
            errors: errors.array().map(err => ({
                field: err.path,
                message: err.msg
            }))
        });
    }
    next();
};

/**
 * Input validation rules for manual or programmatically triggered STK Push
 */
const validateStkPush = [
    body('orderId')
        .optional()
        .trim(),

    body('phoneNumber')
        .optional()
        .trim()
        .matches(/^(?:254|\+254|0)?(7|1)\d{8}$/).withMessage('Please provide a valid Safaricom phone number'),

    body('amount')
        .optional()
        .isFloat({ min: 1 }).withMessage('Amount must be at least 1 KES'),

    validateRequest
];

/**
 * Input validation rules for escrow release execution
 */
const validateEscrowRelease = [
    body('orderId')
        .notEmpty().withMessage('Order ID is required to release escrow funds'),
    validateRequest
];

// ==========================================
// Payment Routes Configuration
// ==========================================

/**
 * @route   POST /api/v1/payments/stk-push
 * @desc    Initiate M-Pesa Express (STK Push) prompt on customer's phone
 * @access  Private / Authenticated Users
 */
router.post(
    '/stk-push',
    protect,
    validateStkPush,
    paymentController.initiateStkPush
);

/**
 * @route   POST /api/v1/payments/mpesa-callback
 * @desc    Safaricom Daraja API Webhook / Callback endpoint
 * @access  Public (Safaricom Daraja Gateway)
 */
router.post(
    '/mpesa-callback',
    paymentController.mpesaCallback
);

/**
 * @route   POST /api/v1/payments/release-escrow
 * @desc    Release held order funds from escrow to vendor/rider
 * @access  Private (Admin / Dispatcher / System)
 */
router.post(
    '/release-escrow',
    protect,
    restrictTo('admin', 'dispatcher'),
    validateEscrowRelease,
    paymentController.releaseEscrow
);

module.exports = router;