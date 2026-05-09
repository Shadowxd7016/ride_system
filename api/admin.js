const router = require('express').Router();
const db     = require('../db');
const auth   = require('../auth');

const adminOnly = auth(['admin']);

// ─── Dashboard Stats ────────────────────────────────────────────────
router.get('/stats', adminOnly, async (req, res) => {
  try {
    const [[{ total_users }]]   = await db.execute(`SELECT COUNT(*) AS total_users FROM USERS`);
    const [[{ total_drivers }]] = await db.execute(`SELECT COUNT(*) AS total_drivers FROM DRIVERS`);
    const [[{ total_rides }]]   = await db.execute(`SELECT COUNT(*) AS total_rides FROM RIDES`);
    const [[{ total_revenue }]] = await db.execute(
      `SELECT COALESCE(SUM(amount),0) AS total_revenue FROM PAYMENTS WHERE status='completed'`
    );
    const [[{ active_rides }]]  = await db.execute(
      `SELECT COUNT(*) AS active_rides FROM RIDES WHERE status IN ('requested','accepted','in_progress')`
    );
    const [[{ pending_complaints }]] = await db.execute(
      `SELECT COUNT(*) AS pending_complaints FROM COMPLAINTS WHERE status='open'`
    );
    const [[{ flagged_drivers }]] = await db.execute(
      `SELECT COUNT(*) AS flagged_drivers FROM ADMIN_FLAGS WHERE resolved = FALSE`
    );

    // --- ADD THESE TWO QUERIES FOR THE CHARTS ---
    
    // 1. Revenue by method
    const [revenue_by_method] = await db.execute(
      `SELECT method, SUM(amount) as total FROM PAYMENTS WHERE status='completed' GROUP BY method`
    );

    // 2. Rides per day (Last 7 days)
    const [rides_per_day] = await db.execute(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') as day, COUNT(*) as count 
       FROM RIDES 
       GROUP BY day 
       ORDER BY day DESC LIMIT 7`
    );
    
    res.json({ 
      total_users, total_drivers, total_rides, total_revenue, 
      active_rides, pending_complaints, flagged_drivers,
      revenue_by_method, 
      rides_per_day: rides_per_day.reverse() // Reverse to show chronological order
    });

  } catch (err) { 
    console.error(err);
    res.status(500).json({ error: err.message }); 
  }
});
// ─── D3-Component 1: Basic SQL Queries ──────────────────────────────
// GET /api/admin/rides/completed/:rider_id — completed rides ordered by DATE
router.get('/rides/completed/:rider_id', adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT r.ride_id, u.full_name AS rider, d.full_name AS driver,
              pl.name AS pickup, dl.name AS dropoff, r.fare, r.status, r.created_at
       FROM RIDES r
       JOIN USERS u  ON u.user_id   = r.rider_id
       JOIN USERS d  ON d.user_id   = r.driver_id
       JOIN LOCATIONS pl ON pl.location_id = r.pickup_loc_id
       JOIN LOCATIONS dl ON dl.location_id = r.dropoff_loc_id
       WHERE r.rider_id = ? AND r.status = 'completed'
       ORDER BY r.created_at DESC`,  // <-- FIXED: ORDER BY DATE, not ride_id
      [req.params.rider_id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// GET /api/admin/rides — Get all rides for the dashboard
router.get('/rides', adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT r.ride_id, ru.full_name AS rider_name, du.full_name AS driver_name,
              pl.name AS pickup, dl.name AS dropoff, r.status, r.fare
       FROM RIDES r
       INNER JOIN USERS ru ON r.rider_id = ru.user_id
       LEFT JOIN USERS du  ON r.driver_id = du.user_id
       INNER JOIN LOCATIONS pl ON r.pickup_loc_id = pl.location_id
       INNER JOIN LOCATIONS dl ON r.dropoff_loc_id = dl.location_id
       ORDER BY r.ride_id DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// GET /api/admin/drivers — all drivers for verification dashboard
router.get('/drivers', adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT d.driver_id, u.full_name, u.email, u.phone,
              d.license_number, d.cnic_no, d.verification_status,
              d.avg_rating, d.total_trips
       FROM DRIVERS d
       JOIN USERS u ON u.user_id = d.driver_id
       ORDER BY d.verification_status = 'pending' DESC, d.total_trips DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/drivers/by-rating — all drivers ordered by rating DESC
router.get('/drivers/by-rating', adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT d.driver_id, u.full_name, u.email, u.phone,
              d.avg_rating, d.total_trips, d.availability_status, d.verification_status
       FROM DRIVERS d
       JOIN USERS u ON u.user_id = d.driver_id
       ORDER BY d.avg_rating DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── D3-Component 2: Aggregate Functions & HAVING ───────────────────
// GET /api/admin/analytics/revenue-by-city — SUM revenue grouped by city
router.get('/analytics/revenue-by-city', adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT pl.city,
              COUNT(*)        AS total_trips,
              SUM(p.amount)   AS total_revenue,
              AVG(p.amount)   AS avg_fare
       FROM PAYMENTS p
       JOIN RIDES r ON r.ride_id = p.ride_id
       JOIN LOCATIONS pl ON pl.location_id = r.pickup_loc_id
       WHERE p.status = 'completed'
       GROUP BY pl.city
       ORDER BY total_revenue DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/analytics/revenue-by-method — SUM revenue by payment method
router.get('/analytics/revenue', adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT p.method AS payment_method,
              COUNT(*)        AS total_transactions,
              SUM(p.amount)   AS total_revenue,
              AVG(p.amount)   AS avg_fare
       FROM PAYMENTS p
       WHERE p.status = 'completed'
       GROUP BY p.method
       ORDER BY total_revenue DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/analytics/low-rated-drivers — AVG < 3.5 with HAVING
router.get('/analytics/low-rated-drivers', adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT r.rated_user_id AS driver_id, u.full_name,
              AVG(r.score) AS avg_score, COUNT(*) AS rating_count
       FROM RATINGS r
       JOIN USERS u ON u.user_id = r.rated_user_id
       JOIN DRIVERS dr ON dr.driver_id = r.rated_user_id
       GROUP BY r.rated_user_id, u.full_name
       HAVING AVG(r.score) < 3.5
       ORDER BY avg_score ASC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/analytics/trips-per-driver — COUNT trips per driver
router.get('/analytics/trips-per-driver', adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT r.driver_id, u.full_name, COUNT(*) AS completed_trips,
              SUM(r.fare) AS total_earned
       FROM RIDES r
       JOIN USERS u ON u.user_id = r.driver_id
       WHERE r.status = 'completed'
       GROUP BY r.driver_id, u.full_name
       ORDER BY completed_trips DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── D3-Component 3: Joins for Reports ──────────────────────────────
// GET /api/admin/reports/full-trip — INNER JOIN: riders, rides, drivers, vehicles
router.get('/reports/full-trip', adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT r.ride_id,
              ru.full_name  AS rider_name,  ru.phone AS rider_phone,
              du.full_name  AS driver_name, du.phone AS driver_phone,
              v.make, v.model, v.license_plate, v.vehicle_type,
              pl.name AS pickup,  dl.name AS dropoff,
              r.status, r.fare, r.created_at,
              p.amount, p.method, p.status AS payment_status
       FROM RIDES r
       INNER JOIN USERS ru      ON ru.user_id    = r.rider_id
       LEFT JOIN USERS du       ON du.user_id    = r.driver_id
       LEFT JOIN VEHICLES v     ON v.vehicle_id  = r.vehicle_id
       INNER JOIN LOCATIONS pl  ON pl.location_id = r.pickup_loc_id
       INNER JOIN LOCATIONS dl  ON dl.location_id = r.dropoff_loc_id
       LEFT  JOIN PAYMENTS p    ON p.ride_id     = r.ride_id
       ORDER BY r.created_at DESC
       LIMIT 200`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/reports/all-riders — LEFT JOIN: all riders including never-rode
router.get('/reports/all-riders', adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT u.user_id, u.full_name, u.email, u.phone, u.account_status,
              COUNT(r.ride_id) AS total_rides,
              COALESCE(SUM(r.fare), 0) AS total_spent,
              MAX(r.created_at) AS last_ride_date
       FROM USERS u
       LEFT JOIN RIDES r ON r.rider_id = u.user_id AND r.status = 'completed'
       WHERE u.role = 'rider'
       GROUP BY u.user_id, u.full_name, u.email, u.phone, u.account_status
       ORDER BY total_rides DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/reports/promo-usage — JOIN payments & promos
router.get('/reports/promo-usage', adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT r.ride_id, ru.full_name AS rider, r.fare,
              p.amount, p.discount, pr.code AS promo_code,
              pr.discount_percentage, pr.usage_count
       FROM RIDES r
       JOIN PAYMENTS p      ON p.ride_id  = r.ride_id
       JOIN RIDE_PROMO rp   ON rp.ride_id = r.ride_id
       JOIN PROMO pr        ON pr.promo_id = rp.promo_id
       JOIN USERS ru        ON ru.user_id  = r.rider_id
       ORDER BY p.discount DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── D3-Component 4: Views ──────────────────────────────────────────
router.get('/views/active-rides', adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(`SELECT * FROM ActiveRidesView LIMIT 100`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/views/top-drivers', adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(`SELECT * FROM TopDriversView`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/views/leaderboard', adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(`SELECT * FROM LeaderboardView LIMIT 20`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Stored Procedure Test Endpoint ─────────────────────────────────
router.post('/fare/calculate', adminOnly, async (req, res) => {
  const { distance_km, duration_min, vehicle_type, hour_of_day } = req.body;
  try {
    const [result] = await db.execute(
      `CALL CalculateFare(?, ?, ?, ?, @final_fare)`,
      [distance_km, duration_min, vehicle_type, hour_of_day]
    );
    const [[{ final_fare }]] = await db.execute(`SELECT @final_fare AS final_fare`);
    res.json({ distance_km, duration_min, vehicle_type, hour_of_day, final_fare });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── User Management ────────────────────────────────────────────────
router.get('/users', adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT user_id, full_name, email, phone, role, account_status, wallet_balance, registration_date
       FROM USERS ORDER BY registration_date DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/users/:id/status', adminOnly, async (req, res) => {
  const { status } = req.body;
  const allowed = ['active', 'suspended', 'banned'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    await db.execute(`UPDATE USERS SET account_status = ? WHERE user_id = ?`, [status, req.params.id]);
    res.json({ message: 'Status updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Vehicle Management ──────────────────────────────────────────────
router.get('/vehicles', adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT v.*, u.full_name AS driver_name
       FROM VEHICLES v JOIN USERS u ON u.user_id = v.driver_id
       ORDER BY v.vehicle_id DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/vehicles/:id/verify', adminOnly, async (req, res) => {
  try {
    await db.execute(`UPDATE VEHICLES SET is_verified = TRUE WHERE vehicle_id = ?`, [req.params.id]);
    res.json({ message: 'Vehicle verified' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Complaints ──────────────────────────────────────────────────────
router.get('/complaints', adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT c.*, u.full_name AS filed_by, r.ride_id FROM COMPLAINTS c
       JOIN USERS u ON u.user_id = c.user_id
       LEFT JOIN RIDES r ON r.ride_id = c.ride_id
       ORDER BY c.created_at DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/complaints/:id/status', adminOnly, async (req, res) => {
  const { status } = req.body;
  try {
    await db.execute(`UPDATE COMPLAINTS SET status = ? WHERE complaint_id = ?`, [status, req.params.id]);
    res.json({ message: 'Complaint updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Admin Flags ─────────────────────────────────────────────────────
router.get('/flags', adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT af.*, u.full_name, u.role FROM ADMIN_FLAGS af
       JOIN USERS u ON u.user_id = af.user_id
       WHERE af.resolved = FALSE
       ORDER BY af.created_at DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/flags/:id/resolve', adminOnly, async (req, res) => {
  try {
    await db.execute(`UPDATE ADMIN_FLAGS SET resolved = TRUE WHERE flag_id = ?`, [req.params.id]);
    res.json({ message: 'Flag resolved' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Promo Management ────────────────────────────────────────────────
router.get('/promos', adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(`SELECT * FROM PROMO ORDER BY expiry_date DESC`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/promos', adminOnly, async (req, res) => {
  const { code, discount_percentage, max_discount, expiry_date, usage_limit } = req.body;
  try {
    const [result] = await db.execute(
      `INSERT INTO PROMO (code, discount_percentage, max_discount, expiry_date, usage_limit)
       VALUES (?, ?, ?, ?, ?)`,
      [code, discount_percentage, max_discount, expiry_date, usage_limit]
    );
    res.status(201).json({ message: 'Promo created', promo_id: result.insertId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/admin/drivers/:id/:status — approve/reject driver verification
// In your routes/admin.js
router.patch('/drivers/:id/:status', adminOnly, async (req, res) => {
  try {
    let { status } = req.params;
    const driverId = req.params.id;
    console.log(`Updating driver #${driverId} verification status to: ${status}`);
    // MANDATORY FIX: Map frontend 'approved' to DB 'verified'
    if (status === 'approved') status = 'verified';

    // Ensure it is lowercase to match ENUM('pending','verified','rejected')
    const finalStatus = status.toLowerCase();

    const [result] = await db.execute(
      `UPDATE DRIVERS SET verification_status = ? WHERE driver_id = ?`,
      [finalStatus, driverId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Driver not found" });
    }

    res.json({ success: true, message: `Driver status updated to ${finalStatus}` });
  } catch (err) {
    console.error("SQL ERROR:", err.message); // Check your terminal for this log
    res.status(500).json({ error: err.message });
  }
});
// ─── Payouts ─────────────────────────────────────────────────────────
router.get('/payouts', adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT p.*, u.full_name AS driver_name, u.email
       FROM PAYOUTS p
       JOIN USERS u ON u.user_id = p.driver_id
       ORDER BY p.requested_at DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/payouts/:id/status', adminOnly, async (req, res) => {
  const { status } = req.body;
  const allowed = ['completed', 'failed'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    await db.execute(
      `UPDATE PAYOUTS SET status = ?, completed_at = ${status === 'completed' ? 'NOW()' : 'NULL'} WHERE payout_id = ?`,
      [status, req.params.id]
    );
    res.json({ success: true, message: `Payout marked as ${status}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;