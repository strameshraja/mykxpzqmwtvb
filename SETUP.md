# Meridian + ICICI Breeze — setup

Two pieces now:
1. **Backend** (`meridian-backend/`) — Python/Flask, talks to Breeze, holds your secret.
2. **Frontend** (`meridian_trading_portal.jsx`) — your existing React app, now calls the backend instead of using fake data.

## 1. Backend setup

In VS Code, open a **new terminal** (keep your `npm run dev` terminal running separately — you'll need both at once).

```powershell
cd meridian-backend
python -m venv venv
venv\Scripts\activate          # on Windows PowerShell
pip install -r requirements.txt
copy .env.example .env
```

Open `.env` and fill in your real `BREEZE_API_KEY` and `BREEZE_API_SECRET` (from https://api.icicidirect.com/apiuser/home).

Run it:
```powershell
python app.py
```
You should see Flask start on `http://localhost:5000`.

## 2. Frontend setup

Replace `src/App.jsx` in your `meridian` Vite project with the new version of `meridian_trading_portal.jsx` (same as before — copy the whole file's contents in, save).

It now expects the backend to be running at `http://localhost:5000` (see the `API_BASE` constant near the top of the file — change it if you run Flask on a different port).

With **both** `python app.py` (backend) and `npm run dev` (frontend) running at the same time, open `http://localhost:5173`.

## 3. Using it

1. Click **Open login page** — a new tab opens ICICI Direct's login.
2. Log in with your credentials + OTP.
3. After success, look at the address bar of the redirected page — copy the value after `apisession=` (or check the network tab per ICICI's docs if it's not visible directly).
4. Paste that value into the **API_Session value** field back in Meridian and click **Connect to Breeze**.
5. You should land on the dashboard with real quotes for the watchlist defined in `app.py` (`WATCHLIST` — edit `stock_code`/`exchange_code` entries there for the instruments you actually want).

## 4. Things to check before placing real orders

- **Stock codes are Breeze-specific**, not plain tickers (e.g. `ICIBAN` for ICICI Bank, not `ICICIBANK`). Look these up in Breeze's Master Scrip File if you add symbols.
- **`place_order` required fields can vary by product type** (cash vs futures vs options) — the backend sends `product`, `action`, `order_type`, `quantity`, `price`, `validity`, `stoploss`; check Breeze's official docs if you get a field-mismatch error for options/futures.
- The session token expires daily — you'll need to repeat the login flow each trading day.
- This backend is single-user/local by design (one in-memory session). Don't expose it to the internet or use it for multiple people without adding real per-user session handling.

## If something errors

- **"backend unreachable" banner in the UI** → check the Flask terminal is still running and didn't crash; check `API_BASE` in the jsx matches Flask's actual port.
- **CORS error in browser console** → confirm `FRONTEND_ORIGIN` in `.env` exactly matches the URL Vite is running on (e.g. `http://localhost:5173`).
- **Breeze errors on `/api/session`** → the session token is usually only valid for a few minutes after login; re-do the login step and paste a fresh one.
