const router = require('express').Router();
const db     = require('../db');   
const auth   = require('../auth');  
const riderAuth = auth(['rider', 'admin']);

// GET /api/rider/profile
router.get('/profile', riderAuth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT user_id, full_name, email, phone, account_status, wallet_balance, registration_date 
       FROM USERS WHERE user_id = ?`,
      [req.user.user_id]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rider/rides — complete ride history
router.get('/rides', riderAuth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT r.ride_id, r.status, r.fare, r.created_at, r.scheduled_at,du.user_id AS driver_id,
              du.full_name AS driver_name, du.phone AS driver_phone,
              v.make, v.model, v.license_plate,
              pl.name AS pickup, dl.name AS dropoff,
              p.amount, p.method, p.status AS payment_status
       FROM RIDES r
       LEFT JOIN USERS du   ON du.user_id    = r.driver_id
       LEFT JOIN VEHICLES v ON v.vehicle_id  = r.vehicle_id
       JOIN LOCATIONS pl    ON pl.location_id = r.pickup_loc_id
       JOIN LOCATIONS dl    ON dl.location_id = r.dropoff_loc_id
       LEFT JOIN PAYMENTS p ON p.ride_id     = r.ride_id
       WHERE r.rider_id = ?
       ORDER BY r.created_at DESC`,
      [req.user.user_id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rider/rides — book a ride (INSERT per DCL)
router.post('/rides', riderAuth, async (req, res) => {
  const { driver_id, vehicle_id, pickup_loc_id, dropoff_loc_id, fare, promo_code, scheduled_at } = req.body;
  try {
    const [result] = await db.execute(
      `INSERT INTO RIDES (rider_id, driver_id, vehicle_id, pickup_loc_id, dropoff_loc_id, fare, status, scheduled_at)
       VALUES (?, ?, ?, ?, ?, ?, 'requested', ?)`,
      [req.user.user_id, driver_id || null, vehicle_id || null, pickup_loc_id, dropoff_loc_id, fare, scheduled_at || null]
    );
    const ride_id = result.insertId;

    // Apply promo if provided
    if (promo_code) {
      const [promos] = await db.execute(
        `SELECT promo_id FROM PROMO WHERE code = ? AND expiry_date >= CURDATE() AND usage_limit > usage_count AND status = 'active'`,
        [promo_code]
      );
      if (promos.length) {
        await db.execute(`INSERT INTO RIDE_PROMO (ride_id, promo_id) VALUES (?, ?)`, [ride_id, promos[0].promo_id]);
      }
    }
    res.status(201).json({ message: 'Ride requested', ride_id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rider/payments — make payment (INSERT per DCL)
router.post('/payments', riderAuth, async (req, res) => {
  const { ride_id, amount, method, discount } = req.body;
  try {
    const [result] = await db.execute(
      `INSERT INTO PAYMENTS (ride_id, rider_id, amount, method, discount, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [ride_id, req.user.user_id, amount, method, discount || 0]
    );
    res.status(201).json({ payment_id: result.insertId, message: 'Payment initiated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rider/ratings — submit rating
router.post('/ratings', riderAuth, async (req, res) => {
  const { ride_id, rated_user_id, score, comment } = req.body;
  console.log('Submitting rating:', { ride_id, rated_user_id, score, comment });
  try {
    await db.execute(
      `INSERT INTO RATINGS (ride_id, rated_by_id, rated_user_id, score, comment)
       VALUES (?, ?, ?, ?, ?)`,
      [ride_id, req.user.user_id, rated_user_id, score, comment || null]
    );
    res.status(201).json({ message: 'Rating submitted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rider/complaints
router.post('/complaints', riderAuth, async (req, res) => {
  const { ride_id, description } = req.body;
  try {
    await db.execute(
      `INSERT INTO COMPLAINTS (ride_id, user_id, description) VALUES (?, ?, ?)`,
      [ride_id, req.user.user_id, description]
    );
    res.status(201).json({ message: 'Complaint submitted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rider/locations
router.get('/locations', riderAuth, async (req, res) => {
  try {
    const [rows] = await db.execute(`SELECT * FROM LOCATIONS ORDER BY name`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rider/promos — available promos
router.get('/promos', riderAuth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT * FROM PROMO WHERE status = 'active' AND expiry_date >= CURDATE() AND usage_limit > usage_count`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rider/wallet — get wallet balance and history
router.get('/wallet', riderAuth, async (req, res) => {
  try {
    const [[user]] = await db.execute(
      `SELECT wallet_balance FROM USERS WHERE user_id = ?`, [req.user.user_id]
    );
    const [transactions] = await db.execute(
      `SELECT p.payment_id, p.amount, p.method, p.status, p.discount, p.transaction_date,
              r.ride_id, pl.name AS pickup, dl.name AS dropoff
       FROM PAYMENTS p
       JOIN RIDES r ON r.ride_id = p.ride_id
       JOIN LOCATIONS pl ON pl.location_id = r.pickup_loc_id
       JOIN LOCATIONS dl ON dl.location_id = r.dropoff_loc_id
       WHERE p.rider_id = ?
       ORDER BY p.transaction_date DESC`,
      [req.user.user_id]
    );
    res.json({ balance: user.wallet_balance, transactions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rider/wallet/topup — add money to wallet
router.post('/wallet/topup', riderAuth, async (req, res) => {
  const { amount } = req.body;
  try {
    await db.execute(
      `UPDATE USERS SET wallet_balance = wallet_balance + ? WHERE user_id = ?`,
      [amount, req.user.user_id]
    );
    res.json({ message: 'Wallet topped up', amount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;