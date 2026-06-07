# Ride Sharing Management System

A robust backend system and localized frontend architecture designed to handle real-time ride logistics, multi-role authentications, and user workflows for dynamic ride management. This system cleanly separates concerns among **Riders**, **Drivers**, and **Administrators**.

---

## 🏛️ Project Architecture

The codebase contains a clean separation between API service layers and interactive customer/employee views:

```text
ride_system/
├── api/
│   ├── admin.js          # Admin endpoints, platform configurations
│   ├── auth.js           # Authentication & token logistics
│   ├── driver.js         # Driver matching, status toggles & payout routes
│   └── rider.js          # Ride requests, tracking, and pricing calculations
├── frontend/
│   ├── admin.html        # Platform administration dashboard
│   ├── driver.html       # Driver availability and incoming request HUD
│   ├── rider.html        # Rider request portal and live pricing viewer
│   └── index.html        # Landing page & role router
├── auth.js               # Global authentication middleware 
├── db.js                 # Database connection & pooling layer
└── .env                  # Environment configurations (ignored in source control)
