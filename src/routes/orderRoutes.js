const express = require('express');
const { body, param, validationResult } = require('express-validator');
const router = express.Router();

const {
    createOrderAndPay,
    getUserOrders,
    getOrderById,
    cancelOrder,
    trackOrder
} = require('../controllers/orderController');

const { protect } = require('../middleware/authMiddleware');

/**
 * Helper middleware to handle express-validator errors
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
 * Validation rules for checkout & order creation
 */
const validateOrderCreation = [
    body('items')
        .isArray({ min: 1 }).withMessage('Order must contain at least one item'),
    
    body('items.*.productId')
        .notEmpty().withMessage('Product ID is required for each item'),

    body('items.*.quantity')
        .isInt({ min: 1 }).withMessage('Item quantity must be a positive integer'),

    body('items.*.price')
        .isFloat({ min: 0 }).withMessage('Item price must be a valid positive number'),

    body('phoneNumber')
        .trim()
        .notEmpty().withMessage('M-Pesa payment phone number is required')
        .matches(/^(?:254|\+254|0)?(7|1)\d{8}$/).withMessage('Please provide a valid Safaricom phone number'),

    body('deliveryAddress')
        .notEmpty().withMessage('Delivery address details are required'),

    body('deliveryLat')
        .notEmpty().withMessage('Delivery latitude is required')
        .isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude value'),

    body('deliveryLon')
        .notEmpty().withMessage('Delivery longitude is required')
        .isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude value'),

    body('paymentMethod')
        .optional()
        .isIn(['MPESA', 'ESCROW', 'CARD']).withMessage('Unsupported payment method'),

    validateRequest
];

/**
 * Validation rules for parameter ID parameters
 */
const validateOrderIdParam = [
    param('id')
        .notEmpty().withMessage('Order ID parameter is required'),
    validateRequest
];

// All order endpoints require authentication
router.use(protect);

/**
 * @route   POST /api/v1/orders
 * @route   POST /api/v1/orders/checkout
 * @desc    Create new order and initiate M-Pesa STK push / Escrow payment
 * @access  Private
 */
router.post('/', validateOrderCreation, createOrderAndPay);
router.post('/checkout', validateOrderCreation, createOrderAndPay);

/**
 * @route   GET /api/v1/orders
 * @desc    Get order history for authenticated user
 * @access  Private
 */
router.get('/', getUserOrders);

/**
 * @route   GET /api/v1/orders/:id
 * @desc    Get detailed order breakdown by ID
 * @access  Private
 */
router.get('/:id', validateOrderIdParam, getOrderById);

/**
 * @route   GET /api/v1/orders/:id/track
 * @desc    Track order delivery status and live rider location
 * @access  Private
 */
router.get('/:id/track', validateOrderIdParam, trackOrder);

/**
 * @route   PATCH /api/v1/orders/:id/cancel
 * @desc    Cancel pending order prior to rider pickup
 * @access  Private
 */
router.patch('/:id/cancel', validateOrderIdParam, cancelOrder);

module.exports = router;