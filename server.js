
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const pool = require("./db");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json({ limit: "3mb" }));

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
    console.error(error.message);
    res.status(500).json({ message: "Database connection failed" });
  }
});

// Get all tickets
app.get("/api/tickets", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM tickets ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ message: "Could not fetch tickets" });
  }
});

// Get one ticket
app.get("/api/tickets/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM tickets WHERE id = $1",
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Ticket not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ message: "Could not fetch ticket" });
  }
});

// Create a ticket
app.post("/api/tickets", async (req, res) => {
  const {
    subject,
    customer,
    email,
    category,
    priority = "Medium",
    description,
    image_urls = [],
  } = req.body;

  if (
    !subject?.trim() ||
    !customer?.trim() ||
    !email?.trim() ||
    !category?.trim() ||
    !description?.trim()
  ) {
    return res.status(400).json({
      message: "Subject, customer, email, category, and description are required",
    });
  }

  if (!["Low", "Medium", "High"].includes(priority)) {
    return res.status(400).json({ message: "Invalid priority" });
  }

  if (
    !Array.isArray(image_urls) ||
    image_urls.length > 2 ||
    image_urls.some(
      (image) => typeof image !== "string" || image.length > 1_400_000
    )
  ) {
    return res.status(400).json({
      message: "Provide up to 2 valid image strings",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO tickets
       (subject, customer, email, category, priority, description, image_urls)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        subject.trim(),
        customer.trim(),
        email.trim(),
        category.trim(),
        priority,
        description.trim(),
        JSON.stringify(image_urls),
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ message: "Could not create ticket" });
  }
});

// Update ticket status
app.patch("/api/tickets/:id/status", async (req, res) => {
  const { status } = req.body;

  if (!["Open", "In Progress", "Resolved"].includes(status)) {
    return res.status(400).json({ message: "Invalid ticket status" });
  }

  try {
    const result = await pool.query(
      `UPDATE tickets
       SET status = $1
       WHERE id = $2
       RETURNING *`,
      [status, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Ticket not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ message: "Could not update ticket status" });
  }
});

app.listen(PORT, () => {
  console.log(`HelpDesk backend running at http://localhost:${PORT}`);
});
