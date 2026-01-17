## Amazon Prime Label Manager

Production-ready internal tool to:
- **Sync** Prime MFN **Unshipped** orders into PostgreSQL
- **View** them in a React dashboard
- **Buy & download** **ZPL203** shipping labels via Merchant Fulfillment
- **Inject** SKU/QTY text into the ZPL footer before printing

### Repo structure
- `backend/` Express API + PostgreSQL
- `frontend/` Vite + React + Tailwind UI

### Prerequisites
- Node.js 18+
- PostgreSQL 14+

### Database Setup

**Option 1: Local PostgreSQL (Windows/WSL)**
```bash
# Install PostgreSQL if not already installed
# Windows: Download from postgresql.org
# WSL/Ubuntu: sudo apt-get install postgresql postgresql-contrib

# Start PostgreSQL service
# Windows: Start PostgreSQL service from Services
# WSL: sudo service postgresql start

# Create database
createdb prime_orders
# Or via psql:
# psql -U postgres
# CREATE DATABASE prime_orders;
```

**Option 2: Docker PostgreSQL**
```bash
docker run --name postgres-prime-orders \
  -e POSTGRES_PASSWORD=yourpassword \
  -e POSTGRES_DB=prime_orders \
  -p 5432:5432 \
  -d postgres:14
```

**Option 3: Cloud Database (e.g., Supabase, Railway, Neon)**
Use the connection string provided by your cloud provider.

### Setup
Create a local `.env` file in `backend/` using this template:

```env
PORT=4000
DATABASE_URL=postgres://user:password@localhost:5432/prime_orders

# Toggle mock mode (no Amazon calls)
USE_MOCK=true

# Rate limiting (disable in development by default)
RATE_LIMIT_ENABLED=true
RATE_LIMIT_SYNC_MAX=10
RATE_LIMIT_SYNC_WINDOW_MS=3600000
RATE_LIMIT_LABEL_MAX=30
RATE_LIMIT_LABEL_WINDOW_MS=3600000
RATE_LIMIT_READ_MAX=100
RATE_LIMIT_READ_WINDOW_MS=60000

# ZPL injection defaults (optional)
ZPL_INJECT_X=50
ZPL_INJECT_Y=1100

# Amazon SP-API (required when USE_MOCK=false)
# Defaults configured for Italy (Marketplace ID: APJ6JRA9NG5V4)
SELLER_ID=...
MARKETPLACE_ID=APJ6JRA9NG5V4  # Italy marketplace (default if not set)
LWA_CLIENT_ID=...
LWA_CLIENT_SECRET=...
REFRESH_TOKEN=...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_SELLING_PARTNER_ROLE_ARN=...
SP_API_REGION=eu-west-1  # Europe region (default)

# Hardcoded Ship-From (Merchant Fulfillment)
# Defaults configured for Italy
SHIP_FROM_NAME=Your Warehouse
SHIP_FROM_ADDRESS_LINE1=123 Example St
SHIP_FROM_ADDRESS_LINE2=
SHIP_FROM_CITY=Rome
SHIP_FROM_STATE=RM
SHIP_FROM_POSTAL_CODE=00100
SHIP_FROM_COUNTRY=IT  # Italy (default)
SHIP_FROM_PHONE=0000000000
```

### Install & run
Backend:

```bash
cd backend
npm install
npm run dev
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Open the UI at `http://localhost:5173`.

### API endpoints
- `POST /api/sync-orders`: fetches unshipped orders, filters Prime-only, hydrates items, inserts into DB with `ON CONFLICT DO NOTHING`
- `GET /api/orders`: returns orders from PostgreSQL
- `POST /api/buy-label`: buys cheapest label and returns modified ZPL (SKU/QTY injected before `^XZ`)

