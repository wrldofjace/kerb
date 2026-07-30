const jwt = require('jsonwebtoken');

// 1. VERIFY JWT TOKEN
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer <TOKEN>

    if (!token) {
        return res.status(401).json({ error: 'Access denied. No authentication token provided.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
        req.user = decoded; // { userId, role, shopId, riderId, ... }
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Invalid or expired token.' });
    }
};

// 2. ROLE-BASED ACCESS CONTROL (RBAC)
const authorizeRoles = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user || !allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ 
                error: `Forbidden. Role '${req.user?.role || 'guest'}' does not have access to this resource.` 
            });
        }
        next();
    };
};

module.exports = {
    authenticateToken,
    authorizeRoles
};