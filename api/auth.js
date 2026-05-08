// backend/routes/auth.js
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const db     = require('../db');
require('dotenv').config();

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { full_name, email, phone, password, role = 'rider', license_number, cnic_no } = req.body;
  if (!full_name || !email || !phone || !password)
    return res.status(400).json({ error: 'All fields are required' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const hash = await bcrypt.hash(password, 10);
    const [result] = await conn.execute(
      `INSERT INTO USERS (full_name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)`,
      [full_name, email, phone, hash, role]
    );
    const userId = result.insertId;
    if (role === 'driver') {
      if (!license_number || !cnic_no) throw new Error('License number and CNIC required for drivers');
      await conn.execute(
        `INSERT INTO DRIVERS (driver_id, license_number, cnic_no) VALUES (?, ?, ?)`,
        [userId, license_number, cnic_no]
      );
    }
    await conn.commit();
    res.status(201).json({ success: true, message: 'Registration successful' });
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email or phone already registered' });
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const [rows] = await db.execute(
      `SELECT user_id, full_name, email, phone, role, account_status, password_hash, wallet_balance FROM USERS WHERE email = ?`,
      [email]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = rows[0];
    if (user.account_status !== 'active') return res.status(403).json({ error: `Account is ${user.account_status}` });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign(
      { user_id: user.user_id, email: user.email, role: user.role, full_name: user.full_name },
      process.env.JWT_SECRET, { expiresIn: '24h' }
    );
    res.json({ token, user: { user_id: user.user_id, full_name: user.full_name, email: user.email, role: user.role, wallet_balance: user.wallet_balance } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;