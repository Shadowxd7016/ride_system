const router = require('express').Router();
const db     = require('../db');
const auth   = require('../auth');

const driverAuth = auth(['driver', 'admin']);

// GET /api/driver/profile
router.get('/profile', driverAuth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT u.user_id, u.full_name, u.email, u.phone,u.wallet_balance,
              d.license_number, d.cnic_no, d.verification_status,
              d.availability_status, d.avg_rating, d.total_trips
       FROM USERS u JOIN DRIVERS d ON d.driver_id = u.user_id
       WHERE u.user_id = ?`,
      [req.user.user_id]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// 1. Get available rides (status = 'requested')
router.get('/available-rides', driverAuth, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT 
        r.ride_id, r.fare, r.created_at,
        u.full_name AS rider_name,
        pl.name AS pickup, 
        dl.name AS destination,
        TIMESTAMPDIFF(MINUTE, r.created_at, NOW()) as time_ago
      FROM RIDES r
      JOIN USERS u ON r.rider_id = u.user_id
      JOIN LOCATIONS pl ON r.pickup_loc_id = pl.location_id
      JOIN LOCATIONS dl ON r.dropoff_loc_id = dl.location_id
      WHERE r.status = 'requested'
      ORDER BY r.created_at DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.patch('/rides/:id/accept', driverAuth, async (req, res) => {
  try {
    const [result] = await db.execute(
      `UPDATE RIDES SET status = 'accepted', driver_id = ?, vehicle_id = (SELECT vehicle_id FROM VEHICLES WHERE driver_id = ? LIMIT 1) 
       WHERE ride_id = ? AND status = 'requested'`,
      [req.user.user_id, req.user.user_id, req.params.id]
    );
    if (result.affectedRows === 0) return res.status(400).json({ error: "Ride already taken" });
    res.json({ message: "Ride accepted" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/driver/availability — toggle online/offline
router.patch('/availability', driverAuth, async (req, res) => {
  const { status } = req.body;
  const allowed = ['available', 'on_trip', 'offline'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    await db.execute(
      `UPDATE DRIVERS SET availability_status = ? WHERE driver_id = ?`,
      [status, req.user.user_id]
    );
    res.json({ message: 'Availability updated', status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/driver/rides — pending + history (SELECT only, per DCL)
router.get('/rides', driverAuth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT r.ride_id, r.status, r.fare, r.created_at, r.completed_at,
              ru.full_name AS rider_name, ru.phone AS rider_phone,
              pl.name AS pickup, dl.name AS dropoff,
              v.make, v.model
       FROM RIDES r
       JOIN USERS ru      ON ru.user_id    = r.rider_id
       JOIN LOCATIONS pl  ON pl.location_id = r.pickup_loc_id
       JOIN LOCATIONS dl  ON dl.location_id = r.dropoff_loc_id
       LEFT JOIN VEHICLES v ON v.vehicle_id = r.vehicle_id
       WHERE r.driver_id = ?
       ORDER BY r.created_at DESC`,
      [req.user.user_id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/driver/rides/:id/status
router.patch('/rides/:id/status', driverAuth, async (req, res) => {
  const { status } = req.body;
  const rideId = req.params.id;
  const driverId = req.user.user_id;

  try {
    // Update ride status
    await db.execute(
      `UPDATE RIDES SET status = ? WHERE ride_id = ? AND driver_id = ?`,
      [status, rideId, driverId]
    );

    // If completing the ride, credit 80% to driver wallet (only if payment method is wallet)
    if (status === 'completed') {
      // Get ride fare and payment method
      const [[payment]] = await db.execute(
        `SELECT p.amount, p.method FROM PAYMENTS p WHERE p.ride_id = ?`,
        [rideId]
      );

      if (payment && payment.method === 'wallet') {
        const driverCut = parseFloat(payment.amount) * 0.80;
        await db.execute(
          `UPDATE USERS SET wallet_balance = wallet_balance + ? WHERE user_id = ?`,
          [driverCut, driverId]
        );
      }
    }

    res.json({ success: true, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
// GET /api/driver/earnings — with commission breakdown
router.get('/earnings', driverAuth, async (req, res) => {
  try {
    const [summary] = await db.execute(
      `SELECT COUNT(*) AS completed_trips,
              COALESCE(SUM(fare), 0) AS gross_earnings,
              COALESCE(SUM(fare * 0.8), 0) AS net_earnings,
              COALESCE(SUM(fare * 0.2), 0) AS commission
       FROM RIDES WHERE driver_id = ? AND status = 'completed'`,
      [req.user.user_id]
    );

    const [history] = await db.execute(
      `SELECT r.ride_id, r.fare, r.created_at, r.completed_at,
              ru.full_name AS rider_name
       FROM RIDES r
       JOIN USERS ru ON ru.user_id = r.rider_id
       WHERE r.driver_id = ? AND r.status = 'completed'
       ORDER BY r.created_at DESC
       LIMIT 50`,
      [req.user.user_id]
    );

    res.json({ summary: summary[0], history });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/driver/vehicles
router.get('/vehicles', driverAuth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT * FROM VEHICLES WHERE driver_id = ?`, [req.user.user_id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/driver/vehicles
router.post('/vehicles', driverAuth, async (req, res) => {
  const { make, model, year, color, license_plate, vehicle_type } = req.body;
  try {
    const [r] = await db.execute(
      `INSERT INTO VEHICLES (driver_id, make, model, year, color, license_plate, vehicle_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.user.user_id, make, model, year, color, license_plate, vehicle_type]
    );
    res.status(201).json({ vehicle_id: r.insertId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/driver/payouts
router.get('/payouts', driverAuth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT * FROM PAYOUTS WHERE driver_id = ? ORDER BY requested_at DESC`,
      [req.user.user_id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/driver/payouts — request payout
router.post('/payouts', driverAuth, async (req, res) => {
  const { amount } = req.body;
  try {
    const [r] = await db.execute(
      `INSERT INTO PAYOUTS (driver_id, amount) VALUES (?, ?)`,
      [req.user.user_id, amount]
    );
    res.status(201).json({ payout_id: r.insertId, message: 'Payout requested' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/driver/payouts — get payout history
router.get('/payouts', driverAuth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT * FROM PAYOUTS WHERE driver_id = ? ORDER BY requested_at DESC`,
      [req.user.user_id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/driver/payouts — request a payout
router.post('/payouts', driverAuth, async (req, res) => {
  const { amount } = req.body;
  try {
    // Check wallet balance first
    const [[user]] = await db.execute(
      `SELECT wallet_balance FROM USERS WHERE user_id = ?`, [req.user.user_id]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (parseFloat(amount) > parseFloat(user.wallet_balance)) {
      return res.status(400).json({ error: `Insufficient balance. Your wallet has PKR ${user.wallet_balance}` });
    }
    const [result] = await db.execute(
      `INSERT INTO PAYOUTS (driver_id, amount, status, requested_at) VALUES (?, ?, 'pending', NOW())`,
      [req.user.user_id, amount]
    );
    res.status(201).json({ payout_id: result.insertId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;