const jwt = require("jsonwebtoken");
const pool = require("../db");

async function authenticateToken(req, res, next) {
  const token = req.cookies?.helpdesk_token;

  if (!token) {
    return res.status(401).json({
      message: "Authentication required. Please log in.",
    });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    const result = await pool.query(
      `SELECT id, name, email, role
       FROM users
       WHERE id = $1`,
      [payload.sub]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        message: "User account not found.",
      });
    }

    // Use the current database role, not only the role in the JWT.
    req.user = result.rows[0];
    next();
  } catch (error) {
    if (error.name === "JsonWebTokenError" ||
        error.name === "TokenExpiredError" ||
        error.name === "NotBeforeError") {
      return res.status(401).json({
        message: "Invalid or expired session. Please log in again.",
      });
    }

    console.error("Authentication error:", error.message);
    return res.status(500).json({
      message: "Authentication could not be verified.",
    });
  }
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        message: "You do not have permission to perform this action.",
      });
    }

    next();
  };
}

module.exports = {
  authenticateToken,
  requireRole,
};