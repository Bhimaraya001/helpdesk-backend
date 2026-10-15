
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const pool = require("./db");

const {
  authenticateToken,
  requireRole,
} = require("./middleware/authMiddleware");

const app = express();
const PORT = process.env.PORT || 5000;

// Check required environment configuration.
if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is missing from the .env file");
}

// Middleware
app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
  })
);

app.use(express.json({ limit: "3mb" }));
app.use(cookieParser());

// Authentication routes
app.use("/api/auth", require("./routes/auth"));

// Health checks
app.get("/", (req, res) => {
  res.json({ message: "HelpDesk Backend is running!" });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "Healthy" });
});

app.get("/api/db-test", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT current_database() AS database"
    );

    res.json({
      message: "PostgreSQL connected successfully!",
      database: result.rows[0].database,
    });
  } catch (error) {
    console.error("Database test error:", error.message);
    res.status(500).json({
      message: "Database connection failed",
    });
  }
});

// --------------------------------------------------
// GET ALL TICKETS — ADMIN ONLY
// --------------------------------------------------
app.get(
  "/api/tickets",
  authenticateToken,
  requireRole("ADMIN"),
  async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT * FROM tickets ORDER BY created_at DESC"
      );

      res.json(result.rows);
    } catch (error) {
      console.error("Fetch tickets error:", error.message);
      res.status(500).json({
        message: "Could not fetch tickets",
      });
    }
  }
);

// --------------------------------------------------
// GET CUSTOMER'S OWN TICKETS
// This route MUST be before /api/tickets/:id
// --------------------------------------------------
app.get(
  "/api/tickets/mine",
  authenticateToken,
  requireRole("CUSTOMER"),
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT * FROM tickets
         WHERE user_id = $1
         ORDER BY created_at DESC`,
        [req.user.id]
      );

      res.json(result.rows);
    } catch (error) {
      console.error("Fetch my tickets error:", error.message);
      res.status(500).json({
        message: "Could not fetch your tickets",
      });
    }
  }
);

// --------------------------------------------------
// GET ONE TICKET — ADMIN OR OWNER
// --------------------------------------------------
app.get(
  "/api/tickets/:id",
  authenticateToken,
  async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({
        message: "Invalid ticket ID",
      });
    }

    try {
      const result = await pool.query(
        `SELECT *
         FROM tickets
         WHERE id = $1
           AND ($2::text = 'ADMIN' OR user_id = $3)`,
        [id, req.user.role, req.user.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          message: "Ticket not found",
        });
      }

      res.json(result.rows[0]);
    } catch (error) {
      console.error("Fetch ticket error:", error.message);
      res.status(500).json({
        message: "Could not fetch ticket",
      });
    }
  }
);

// --------------------------------------------------
// CREATE TICKET — AUTHENTICATED USER
// Customer identity comes from the verified session.
// --------------------------------------------------
app.post(
  "/api/tickets",
  authenticateToken,
  async (req, res) => {
    const {
      subject,
      category,
      priority = "Medium",
      description,
      image_urls = [],
    } = req.body;

    if (
      typeof subject !== "string" ||
      typeof category !== "string" ||
      typeof description !== "string" ||
      !subject.trim() ||
      !category.trim() ||
      !description.trim()
    ) {
      return res.status(400).json({
        message: "Subject, category, and description are required",
      });
    }

    if (
      subject.trim().length > 200 ||
      category.trim().length > 100 ||
      description.trim().length > 10000
    ) {
      return res.status(400).json({
        message: "One or more fields exceed the allowed length",
      });
    }

    if (!["Low", "Medium", "High", "Urgent"].includes(priority)) {
      return res.status(400).json({
        message: "Invalid priority",
      });
    }

    if (
      !Array.isArray(image_urls) ||
      image_urls.length > 2 ||
      image_urls.some(
        (image) =>
          typeof image !== "string" ||
          image.length > 1_400_000
      )
    ) {
      return res.status(400).json({
        message: "Provide up to 2 valid image strings",
      });
    }

    try {
      const result = await pool.query(
        `INSERT INTO tickets
          (subject, customer, email, category, priority,
           description, image_urls, user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          subject.trim(),
          req.user.name,
          req.user.email,
          category.trim(),
          priority,
          description.trim(),
          JSON.stringify(image_urls),
          req.user.id,
        ]
      );

      res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error("Create ticket error:", error.message);
      res.status(500).json({
        message: "Could not create ticket",
      });
    }
  }
);


 // --------------------------------------------------
 // UPDATE TICKET STATUS — ADMIN ONLY + HISTORY
 // --------------------------------------------------
app.patch(
  "/api/tickets/:id/status",
  authenticateToken,
  requireRole("ADMIN"),
  async (req, res) => {
    const id = Number(req.params.id);
    const { status } = req.body;

    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({
        message: "Invalid ticket ID",
      });
    }

    if (!["Open", "In Progress", "Resolved"].includes(status)) {
      return res.status(400).json({
        message: "Invalid ticket status",
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Lock this ticket while its status is being updated.
      const ticketResult = await client.query(
        `SELECT id, status
         FROM tickets
         WHERE id = $1
         FOR UPDATE`,
        [id]
      );

      if (ticketResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          message: "Ticket not found",
        });
      }

      const ticket = ticketResult.rows[0];
      const oldStatus = ticket.status;

      // Avoid recording duplicate history for unchanged status.
      if (oldStatus === status) {
        await client.query("COMMIT");

        return res.json({
          ...ticket,
          status: oldStatus,
          message: "Ticket status is unchanged",
        });
      }

      // Update the ticket status.
      const updatedResult = await client.query(
        `UPDATE tickets
         SET status = $1
         WHERE id = $2
         RETURNING *`,
        [status, id]
      );

      // Record who changed it and when.
      await client.query(
        `INSERT INTO ticket_history
           (ticket_id, old_status, new_status, changed_by)
         VALUES ($1, $2, $3, $4)`,
        [
          id,
          oldStatus,
          status,
          req.user.id,
        ]
      );

      await client.query("COMMIT");

      return res.json(updatedResult.rows[0]);
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Transaction rollback error:", rollbackError.message);
      }

      console.error("Update ticket/history error:", error.message);

      return res.status(500).json({
        message: "Could not update ticket status",
      });
    } finally {
      client.release();
    }
  }
);

 // --------------------------------------------------
 // GET TICKET HISTORY — ADMIN OR TICKET OWNER
 // --------------------------------------------------
app.get(
  "/api/tickets/:id/history",
  authenticateToken,
  async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({
        message: "Invalid ticket ID",
      });
    }

    try {
      // Find the ticket and its owner.
      const ticketResult = await pool.query(
        `SELECT id, user_id
         FROM tickets
         WHERE id = $1`,
        [id]
      );

      if (ticketResult.rows.length === 0) {
        return res.status(404).json({
          message: "Ticket not found",
        });
      }

      const ticket = ticketResult.rows[0];
      const isAdmin = req.user.role === "ADMIN";
      const isOwner =
        ticket.user_id != null &&
        String(ticket.user_id) === String(req.user.id);

      // Customers may only see their own ticket history.
      if (!isAdmin && !isOwner) {
        return res.status(403).json({
          message: "You are not allowed to view this ticket history",
        });
      }

      const historyResult = await pool.query(
        `SELECT
           id,
           ticket_id,
           old_status,
           new_status,
           changed_by,
           comment,
           created_at
         FROM ticket_history
         WHERE ticket_id = $1
         ORDER BY created_at ASC, id ASC`,
        [id]
      );

      return res.json(historyResult.rows);
    } catch (error) {
      console.error("Get ticket history error:", error.message);

      return res.status(500).json({
        message: "Could not retrieve ticket history",
      });
    }
  }
);

// Start server
app.listen(PORT, () => {
  console.log(`HelpDesk backend running at http://localhost:${PORT}`);
});