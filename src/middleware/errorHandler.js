const logger = require('../utils/logger');

/**
 * Custom Error Class for operational errors
 */
class AppError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = true;
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * Centralized Global Error Handler Middleware
 */
const errorHandler = (err, req, res, next) => {
    err.statusCode = err.statusCode || 500;
    err.status = err.status || 'error';

    // Log the error via Winston
    logger.error({
        message: err.message,
        statusCode: err.statusCode,
        stack: err.stack,
        path: req.originalUrl,
        method: req.method,
        ip: req.ip
    });

    if (process.env.NODE_ENV === 'production') {
        // Operational, trusted error: send message to client
        if (err.isOperational) {
            return res.status(err.statusCode).json({
                status: err.status,
                error: err.message
            });
        }
        // Programming or unknown error: don't leak error details
        return res.status(500).json({
            status: 'error',
            error: 'Something went wrong on the server.'
        });
    }

    // Development Mode: Send full error stack
    res.status(err.statusCode).json({
        status: err.status,
        error: err.message,
        stack: err.stack
    });
};

module.exports = {
    AppError,
    errorHandler
};