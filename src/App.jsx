import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { TrendingUp, TrendingDown, Wifi, WifiOff, LogOut, ShieldCheck, ExternalLink, ArrowUpRight, ArrowDownRight, RefreshCw, Wallet, X, Search, Plus, Loader2, BarChart3, ArrowLeft, Target, Bot, Download, Trash2 } from "lucide-react";

// Point this at your Flask backend (see meridian-backend/app.py)
const API_BASE = "http://localhost:5000";

async function api(path, options = {}) {
  const res = await fetch(API_BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- sparkline (kept for visual history of live prices) ----------
function Sparkline({ data, width = 96, height = 32, positive }) {
  if (!data || data.length < 2) {
    return <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} />;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * width;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block" }}>
      <polyline points={points} fill="none" stroke={positive ? "var(--up)" : "var(--down)"} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---------- funds display (renders whatever shape Breeze's get_funds returns) ----------
function FundsDisplay({ data }) {
  if (data.error) {
    return <div className="error-line">{data.error}</div>;
  }
  const payload = data.Success && typeof data.Success === "object" ? data.Success : data;
  if (!payload || typeof payload !== "object") {
    return <div className="pos-empty">No fund details returned.</div>;
  }
  const entries = Object.entries(payload).filter(([k]) => k !== "Error" && k !== "Status");
  if (entries.length === 0) {
    return <div className="pos-empty">No fund details returned.</div>;
  }
  return (
    <div className="funds-rows">
      {entries.map(([key, value]) => (
        <div className="funds-row" key={key}>
          <span className="funds-key">{key.replace(/_/g, " ")}</span>
          <span className="funds-val">{typeof value === "object" ? JSON.stringify(value) : String(value)}</span>
        </div>
      ))}
    </div>
  );
}

// ---------- candlestick chart ----------
function CandlestickChart({ candles, width = 800, height = 260, levels = [] }) {
  if (!candles || candles.length === 0) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <text x={width / 2} y={height / 2} textAnchor="middle" fill="var(--ink-dim)" fontSize="12">
          No candle data yet
        </text>
      </svg>
    );
  }

  const gutter = levels.length ? Math.min(165, Math.round(width * 0.22)) : 10;
  const padding = { top: 10, right: gutter, bottom: 10, left: 54 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  let min = Math.min(...candles.map((c) => c.low));
  let max = Math.max(...candles.map((c) => c.high));
  const base = max - min || 1;
  // Levels close to the candles are pulled into the scale and drawn as real lines;
  // levels far outside are shown as ▲ / ▼ markers so the candles don't get squashed.
  const near = levels.filter((l) => l.price >= min - base * 0.6 && l.price <= max + base * 0.6);
  near.forEach((l) => {
    min = Math.min(min, l.price);
    max = Math.max(max, l.price);
  });
  const far = levels.filter((l) => !near.includes(l));
  const range = max - min || 1;

  const n = candles.length;
  const slot = plotW / n;
  const bodyWidth = Math.max(2, Math.min(14, slot * 0.6));

  const yFor = (v) => padding.top + plotH - ((v - min) / range) * plotH;

  const gridLines = 4;

  // keep the right-hand labels of nearby lines from overlapping
  const marks = near.map((l) => ({ ...l, y: yFor(l.price) })).sort((a, b) => a.y - b.y);
  let lastY = -Infinity;
  marks.forEach((m) => {
    m.ly = Math.max(m.y, lastY + 11);
    lastY = m.ly;
  });
  const above = far.filter((l) => l.price > max);
  const below = far.filter((l) => l.price < min);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {Array.from({ length: gridLines + 1 }).map((_, i) => {
        const y = padding.top + (plotH / gridLines) * i;
        const val = max - (range / gridLines) * i;
        return (
          <g key={i}>
            <line x1={padding.left} x2={width - padding.right} y1={y} y2={y} stroke="var(--line)" strokeWidth="1" />
            <text x={padding.left - 8} y={y + 3} textAnchor="end" fontSize="9.5" fill="var(--ink-dim)" fontFamily="var(--font-mono)">
              {val.toFixed(val > 1000 ? 0 : 2)}
            </text>
          </g>
        );
      })}
      {candles.map((c, i) => {
        const cx = padding.left + slot * i + slot / 2;
        const up = c.close >= c.open;
        const color = up ? "var(--up)" : "var(--down)";
        const yHigh = yFor(c.high);
        const yLow = yFor(c.low);
        const yOpen = yFor(c.open);
        const yClose = yFor(c.close);
        const bodyTop = Math.min(yOpen, yClose);
        const bodyH = Math.max(1, Math.abs(yClose - yOpen));
        return (
          <g key={i}>
            <line x1={cx} x2={cx} y1={yHigh} y2={yLow} stroke={color} strokeWidth="1" />
            <rect x={cx - bodyWidth / 2} y={bodyTop} width={bodyWidth} height={bodyH} fill={color} />
          </g>
        );
      })}
      {marks.map((m) => (
        <g key={m.label}>
          <line x1={padding.left} x2={width - padding.right} y1={m.y} y2={m.y} stroke={m.color} strokeWidth="1.2" strokeDasharray={m.dash || "6 3"} opacity="0.9" />
          <text x={width - padding.right + 5} y={m.ly + 3} fontSize="10" fill={m.color} fontFamily="var(--font-mono)">{m.label}</text>
        </g>
      ))}
      {above.map((l, i) => (
        <text key={l.label} x={width - padding.right + 5} y={padding.top + 9 + i * 11} fontSize="10" fill={l.color} fontFamily="var(--font-mono)">▲ {l.label}</text>
      ))}
      {below.map((l, i) => (
        <text key={l.label} x={width - padding.right + 5} y={height - padding.bottom - 2 - i * 11} fontSize="10" fill={l.color} fontFamily="var(--font-mono)">▼ {l.label}</text>
      ))}
    </svg>
  );
}

// ---------- add-symbol search box ----------
function AddSymbolBox({ onAdd }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await api(`/api/search?q=${encodeURIComponent(query.trim())}`);
        setResults(data.results || []);
        setOpen(true);
      } catch (e) {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 350);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  function pick(item) {
    onAdd(item);
    setQuery("");
    setResults([]);
    setOpen(false);
  }

  return (
    <div className="add-symbol">
      <div className="add-symbol-input">
        <Search size={13} />
        <input
          type="text"
          placeholder="Add stock or index…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
        />
        {loading && <Loader2 size={13} className="spin-icon" />}
      </div>
      {open && results.length > 0 && (
        <div className="add-symbol-dropdown">
          {results.map((r) => (
            <button key={r.stock_code + r.exchange_code} className="add-symbol-option" onClick={() => pick(r)}>
              <div>
                <div className="add-symbol-code">{r.stock_code}</div>
                <div className="add-symbol-label">{r.label}</div>
              </div>
              <span className="add-symbol-meta">
                {r.exchange_code} {r.kind === "index" ? "· index" : ""}
              </span>
            </button>
          ))}
        </div>
      )}
      {open && !loading && query.trim().length >= 2 && results.length === 0 && (
        <div className="add-symbol-dropdown">
          <div className="pos-empty">No matches on the broker for "{query}".</div>
        </div>
      )}
    </div>
  );
}

// ---------- connect screen: real Breeze two-step flow ----------
function ConnectScreen({ onConnect }) {
  const [loginUrl, setLoginUrl] = useState(null);
  const [sessionToken, setSessionToken] = useState("");
  const [status, setStatus] = useState("idle"); // idle | loading-url | connecting | error
  const [error, setError] = useState("");

  async function handleOpenLogin() {
    setStatus("loading-url");
    setError("");
    try {
      const data = await api("/api/login-url");
      setLoginUrl(data.login_url);
      window.open(data.login_url, "_blank", "noopener,noreferrer");
      setStatus("idle");
    } catch (e) {
      setError(e.message);
      setStatus("error");
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!sessionToken.trim()) {
      setError("Paste the API_Session value from the redirected URL first.");
      setStatus("error");
      return;
    }
    setError("");
    setStatus("connecting");
    try {
      const data = await api("/api/session", {
        method: "POST",
        body: JSON.stringify({ session_token: sessionToken.trim() }),
      });
      onConnect(data);
    } catch (e) {
      setError(e.message);
      setStatus("error");
    }
  }

  return (
    <div className="screen connect-screen">
      <div className="connect-wrap">
        <div className="brand">
          <div className="brand-mark">S</div>
          <div>
            <div className="brand-name">STRAMESHRAJA</div>
            <div className="brand-sub">Dashboard — ICICI Breeze</div>
          </div>
        </div>

        <form className="connect-card" onSubmit={handleSubmit}>
          <div className="card-head">
            <ShieldCheck size={16} />
            <span>Connect your Breeze session</span>
          </div>
          <p className="card-copy">
            Breeze requires a fresh login each day. Open the login page, sign in with your ICICI Direct
            credentials and OTP, then copy the <code>API_Session</code> value from the redirected URL back here.
          </p>

          <div className="step">
            <div className="step-num">1</div>
            <div className="step-body">
              <div className="step-title">Open the ICICI Direct login page</div>
              <button type="button" className="secondary-btn" onClick={handleOpenLogin} disabled={status === "loading-url"}>
                <ExternalLink size={14} /> Open login page
              </button>
            </div>
          </div>

          <div className="step">
            <div className="step-num">2</div>
            <div className="step-body">
              <div className="step-title">Paste the session token</div>
              <label className="field">
                <span>API_Session value</span>
                <input
                  type="text"
                  placeholder="e.g. 47281639"
                  value={sessionToken}
                  onChange={(e) => setSessionToken(e.target.value)}
                  autoComplete="off"
                  spellCheck="false"
                />
              </label>
            </div>
          </div>

          {status === "error" && <div className="error-line">{error}</div>}

          <button className="connect-btn" type="submit" disabled={status === "connecting"}>
            {status === "connecting" ? (
              <>
                <span className="spinner" /> Establishing session…
              </>
            ) : (
              <>Connect to Breeze</>
            )}
          </button>

          <div className="card-foot">
            <Wifi size={13} />
            <span>Your API key and secret stay on your local backend server — never sent to this page.</span>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------- live market feed hook, backed by the Flask API ----------
function useLiveWatchlist(pollMs = 4000) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const historyRef = useRef({}); // stock_code -> array of recent ltp values

  const refresh = useCallback(async () => {
    try {
      const data = await api("/api/watchlist");
      const next = (data.watchlist || []).map((item) => {
        const key = item.stock_code;
        const hist = historyRef.current[key] || [];
        const ltp = Number(item.ltp);
        const updatedHist = Number.isFinite(ltp) ? [...hist.slice(-39), ltp] : hist;
        historyRef.current[key] = updatedHist;
        return { ...item, history: updatedHist };
      });
      setRows(next);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  return { rows, error, refresh };
}

// ---------- intraday expected range page (Pine Script HLC range logic) ----------
function IntradayRangePage({ onBack }) {
  const [symbol, setSymbol] = useState("NIFTY");
  const [atm, setAtm] = useState("");
  const [expiry, setExpiry] = useState("");
  const [status, setStatus] = useState("idle"); // idle | loading | done | error
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  async function handleCalculate(e) {
    e.preventDefault();
    if (!atm || !expiry) {
      setError("Enter the ATM strike and expiry date.");
      setStatus("error");
      return;
    }
    setStatus("loading");
    setError("");
    try {
      const data = await api(
        `/api/intraday-range?symbol=${symbol}&atm=${encodeURIComponent(atm)}&expiry=${encodeURIComponent(expiry)}`
      );
      setResult(data);
      setStatus("done");
    } catch (e2) {
      setError(e2.message);
      setStatus("error");
    }
  }

  return (
    <div className="screen dashboard">
      <header className="topbar">
        <div className="brand small">
          <div className="brand-mark">S</div>
          <span className="brand-name">STRAMESHRAJA</span>
        </div>
        <div className="topbar-right">
          <button className="secondary-btn compact" onClick={onBack}>
            <ArrowLeft size={14} /> Back to dashboard
          </button>
        </div>
      </header>

      <div className="intraday-wrap">
        <div className="intraday-form-card">
          <div className="card-head">
            <BarChart3 size={16} /> <span>Intraday expected range</span>
          </div>
          <p className="card-copy">
            Replicates the "Earth &amp; HLC Range" indicator: an ATM straddle range built from the previous close of
            the ATM Call and Put. Enter the same inputs the script asks for — index, ATM strike, and expiry — and
            this pulls live option prices from your Breeze session to compute it.
          </p>

          <form onSubmit={handleCalculate} className="ticket-form">
            <label className="field">
              <span>Index</span>
              <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
                <option value="NIFTY">NIFTY</option>
                <option value="BANKNIFTY">BANKNIFTY</option>
                <option value="FINNIFTY">FINNIFTY</option>
                <option value="MIDCAP">MIDCAP</option>
              </select>
            </label>

            <label className="field">
              <span>ATM strike</span>
              <input type="number" step="any" placeholder="e.g. 26250" value={atm} onChange={(e) => setAtm(e.target.value)} />
            </label>

            <label className="field">
              <span>Expiry date</span>
              <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
            </label>

            {status === "error" && <div className="error-line">{error}</div>}

            <button className="connect-btn" type="submit" disabled={status === "loading"}>
              {status === "loading" ? (
                <>
                  <span className="spinner" /> Calculating…
                </>
              ) : (
                <>Calculate range</>
              )}
            </button>
          </form>
        </div>

        {result && (
          <div className="intraday-result-card">
            <div className="card-head">
              <span>
                {result.symbol} · ATM {result.atm} · Exp {result.expiry_date}
              </span>
            </div>

            {result.warnings && result.warnings.length > 0 && (
              <div className="warn-box">
                {result.warnings.map((w, i) => (
                  <div key={i} className="warn-line">{w}</div>
                ))}
              </div>
            )}

            <div className="range-grid">
              <div className="range-cell">
                <div className="range-label">ATM Call prev close</div>
                <div className="range-value">{result.ce_prev_close ?? "—"}</div>
              </div>
              <div className="range-cell">
                <div className="range-label">ATM Put prev close</div>
                <div className="range-value">{result.pe_prev_close ?? "—"}</div>
              </div>
              <div className="range-cell">
                <div className="range-label">Straddle premium</div>
                <div className="range-value">{result.straddle_premium?.toFixed?.(2) ?? "—"}</div>
              </div>
              <div className="range-cell">
                <div className="range-label">Lot size</div>
                <div className="range-value">{result.lot_size}</div>
              </div>
            </div>

            {result.lines ? (
              <div className="lines-grid">
                <div className="line-row up">
                  <span>Line 3 — max upper</span>
                  <span>{result.lines.line3_max_upper.toFixed(2)}</span>
                </div>
                <div className="line-row up">
                  <span>Line 1 — min upper</span>
                  <span>{result.lines.line1_min_upper.toFixed(2)}</span>
                </div>
                <div className="line-row mid">
                  <span>ATM (Line 5)</span>
                  <span>{result.atm.toFixed(2)}</span>
                </div>
                <div className="line-row down">
                  <span>Line 2 — min lower</span>
                  <span>{result.lines.line2_min_lower.toFixed(2)}</span>
                </div>
                <div className="line-row down">
                  <span>Line 4 — max lower</span>
                  <span>{result.lines.line4_max_lower.toFixed(2)}</span>
                </div>
              </div>
            ) : (
              <div className="pos-empty">Range unavailable — see warnings above (usually a strike/expiry that has no live quote).</div>
            )}

            {(result.underlying?.pdh_prev_high || result.underlying?.tdo_today_open) && (
              <>
                <div className="panel-title" style={{ marginTop: 16 }}>Underlying reference</div>
                <div className="range-grid">
                  <div className="range-cell">
                    <div className="range-label">TDO (today's open)</div>
                    <div className="range-value">{result.underlying.tdo_today_open ?? "—"}</div>
                  </div>
                  <div className="range-cell">
                    <div className="range-label">PDH (prev high)</div>
                    <div className="range-value">{result.underlying.pdh_prev_high ?? "—"}</div>
                  </div>
                  <div className="range-cell">
                    <div className="range-label">PDL (prev low)</div>
                    <div className="range-value">{result.underlying.pdl_prev_low ?? "—"}</div>
                  </div>
                  <div className="range-cell">
                    <div className="range-label">PDC (prev close)</div>
                    <div className="range-value">{result.underlying.pdc_prev_close ?? "—"}</div>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- shared helpers for sniper levels + trading bot ----------
// Default expiry = upcoming Tuesday (NIFTY weekly expiry). Editable by the user.
function upcomingTuesdayISO() {
  const d = new Date();
  d.setDate(d.getDate() + ((2 - d.getDay() + 7) % 7));
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const fmt2 = (v) => (v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v).toFixed(2) : "—");
const fmtMoney = (v) =>
  Number.isFinite(Number(v)) ? Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
const fmtSigned = (v) => (Number.isFinite(Number(v)) ? (v >= 0 ? "+" : "") + fmtMoney(v) : "—");
const fmtTime = (iso) =>
  iso
    ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    : "—";
const LEVEL_NAMES = ["ATM", "ATM+1", "ATM-1"];

// Loads sniper levels. Shared by the Sniper Levels page and the Trading Bot page.
//  - atmOverride "" => ATM derived from NIFTY's day close; otherwise the typed ATM drives every calculation
//  - a request counter makes sure a slow, older response can never overwrite a newer one
//  - an auto result only fills the ATM box when it is still empty, so it can't erase what the user typed
function useSniperLevels() {
  const [expiry, setExpiry] = useState(upcomingTuesdayISO());
  const [atmInput, setAtmInput] = useState("");
  const [status, setStatus] = useState("idle"); // idle | loading | done | error
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [loadedExpiry, setLoadedExpiry] = useState(null);
  const reqRef = useRef(0);

  const calculate = useCallback(
    async (atmOverride) => {
      if (!expiry) {
        setError("Select the option expiry date.");
        setStatus("error");
        return;
      }
      const id = ++reqRef.current;
      const expiryAtCall = expiry;
      setStatus("loading");
      setError("");
      try {
        const qs = `expiry=${encodeURIComponent(expiryAtCall)}` + (atmOverride ? `&atm=${encodeURIComponent(atmOverride)}` : "");
        const data = await api(`/api/sniper-levels?${qs}`);
        if (id !== reqRef.current) return; // superseded by a newer request
        setResult(data);
        setLoadedExpiry(expiryAtCall);
        if (!atmOverride) setAtmInput((prev) => (prev === "" ? String(data.atm) : prev));
        setStatus("done");
      } catch (e) {
        if (id !== reqRef.current) return;
        setError(e.message);
        setStatus("error");
      }
    },
    [expiry]
  );

  useEffect(() => {
    calculate("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetToAuto() {
    setAtmInput("");
    calculate("");
  }

  return { expiry, setExpiry, atmInput, setAtmInput, status, error, result, loadedExpiry, calculate, resetToAuto };
}

// Support / resistance table: the six sniper bands plus the NIFTY close as the dividing line
function SrTable({ levels, reference }) {
  const bandRows = (levels || [])
    .flatMap((l) => [
      l.upper_band != null ? { label: `${l.name} sniper upper`, price: l.upper_band } : null,
      l.lower_band != null ? { label: `${l.name} sniper lower`, price: l.lower_band } : null,
    ])
    .filter(Boolean);

  if (bandRows.length === 0 || reference == null) {
    return <div className="pos-empty">Levels unavailable — see warnings (usually an expiry/strike with no daily candle).</div>;
  }
  const rows = [...bandRows, { label: "NIFTY close", price: reference, isRef: true }].sort((a, b) => b.price - a.price);

  return (
    <div className="sr-scroll">
      <table className="sr-table">
        <thead>
          <tr>
            <th>Level</th>
            <th>Price</th>
            <th>From NIFTY close</th>
            <th>Type</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            if (r.isRef) {
              return (
                <tr key="ref" className="ref">
                  <td>{r.label}</td>
                  <td>{fmt2(r.price)}</td>
                  <td>—</td>
                  <td>Reference</td>
                </tr>
              );
            }
            const diff = r.price - reference;
            const isRes = diff > 0;
            return (
              <tr key={r.label} className={isRes ? "res" : "sup"}>
                <td>{r.label}</td>
                <td>{fmt2(r.price)}</td>
                <td>
                  {diff >= 0 ? "+" : ""}
                  {diff.toFixed(2)} ({diff >= 0 ? "+" : ""}
                  {((diff / reference) * 100).toFixed(2)}%)
                </td>
                <td>{isRes ? "Resistance" : "Support"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- daily sniper levels page ----------
function SniperLevelsPage({ onBack }) {
  const { expiry, setExpiry, atmInput, setAtmInput, status, error, result, calculate, resetToAuto } = useSniperLevels();

  function handleSubmit(e) {
    e.preventDefault();
    calculate(atmInput.trim());
  }

  const levels = result?.levels || [];
  const byName = Object.fromEntries(levels.map((l) => [l.name, l]));

  const summary = [
    ...LEVEL_NAMES.map((n) => ({ label: `${n} sniper`, value: byName[n]?.sniper_value })),
    ...LEVEL_NAMES.flatMap((n) => [
      { label: `${n} sniper upper`, value: byName[n]?.upper_band },
      { label: `${n} sniper lower`, value: byName[n]?.lower_band },
    ]),
  ];

  return (
    <div className="screen dashboard">
      <header className="topbar">
        <div className="brand small">
          <div className="brand-mark">S</div>
          <span className="brand-name">STRAMESHRAJA</span>
        </div>
        <div className="topbar-right">
          <button className="secondary-btn compact" onClick={onBack}>
            <ArrowLeft size={14} /> Back to dashboard
          </button>
        </div>
      </header>

      <div className="intraday-wrap">
        <div className="intraday-form-card">
          <div className="card-head">
            <Target size={16} /> <span>Daily sniper levels</span>
          </div>
          <p className="card-copy">
            ATM = NIFTY day close rounded to the nearest 100. For each level (ATM, ATM+1, ATM−1) the sniper value is
            (CE close at strike+100 + PE close at strike−100) / 2, with upper = strike + value and lower = strike − value.
            If you type an ATM strike, every level is calculated from it.
          </p>

          {/* noValidate: the browser must not silently block strikes that aren't multiples of 100 (e.g. 22850) */}
          <form onSubmit={handleSubmit} className="ticket-form" noValidate>
            <label className="field">
              <span>Option expiry date</span>
              <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
            </label>

            <label className="field">
              <span>ATM strike (editable)</span>
              <input type="number" step="50" placeholder="auto from NIFTY close" value={atmInput} onChange={(e) => setAtmInput(e.target.value)} />
            </label>

            {status === "error" && <div className="error-line">{error}</div>}

            <button className="connect-btn" type="submit" disabled={status === "loading"}>
              {status === "loading" ? (
                <>
                  <span className="spinner" /> Calculating…
                </>
              ) : (
                <>Calculate sniper levels</>
              )}
            </button>
            <button type="button" className="secondary-btn" onClick={resetToAuto} disabled={status === "loading"}>
              <RefreshCw size={13} /> Reset ATM to auto
            </button>
          </form>
        </div>

        {result && (
          <div className="intraday-result-card">
            <div className="card-head">
              <span>
                NIFTY · ATM {result.atm}
                {result.is_manual_atm ? " (manual)" : " (auto)"} · Exp {result.expiry_date}
              </span>
            </div>

            {result.warnings && result.warnings.length > 0 && (
              <div className="warn-box">
                {result.warnings.map((w, i) => (
                  <div key={i} className="warn-line">{w}</div>
                ))}
              </div>
            )}

            <div className="range-grid">
              <div className="range-cell">
                <div className="range-label">NIFTY day close{result.nifty_close_date ? ` (${result.nifty_close_date})` : ""}</div>
                <div className="range-value">{fmt2(result.nifty_close)}</div>
              </div>
              <div className="range-cell">
                <div className="range-label">Auto ATM (nearest 100)</div>
                <div className="range-value">{result.atm_auto ?? "—"}</div>
              </div>
              <div className="range-cell">
                <div className="range-label">ATM used for calculation</div>
                <div className="range-value">{result.atm}</div>
              </div>
            </div>

            <div className="panel-title">Summary</div>
            <div className="funds-rows" style={{ maxHeight: "none", marginBottom: 18 }}>
              {summary.map((s) => (
                <div className="funds-row" key={s.label}>
                  <span className="funds-key" style={{ textTransform: "none" }}>{s.label}</span>
                  <span className="funds-val">{fmt2(s.value)}</span>
                </div>
              ))}
            </div>

            <div className="panel-title">Support &amp; resistance levels</div>
            <SrTable levels={levels} reference={result.reference_price} />

            <div className="panel-title" style={{ marginTop: 18 }}>Calculation details</div>
            <div className="sr-scroll">
              <table className="sr-table">
                <thead>
                  <tr>
                    <th>Level</th>
                    <th>Strike</th>
                    <th>CE close</th>
                    <th>PE close</th>
                    <th>Sniper</th>
                  </tr>
                </thead>
                <tbody>
                  {LEVEL_NAMES.map((n) => {
                    const l = byName[n];
                    if (!l) return null;
                    return (
                      <tr key={n}>
                        <td>{n}</td>
                        <td>{l.center}</td>
                        <td>{l.ce_strike}: {fmt2(l.ce_close)}</td>
                        <td>{l.pe_strike}: {fmt2(l.pe_close)}</td>
                        <td>{fmt2(l.sniper_value)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- trading bot (PAPER TRADING ONLY — nothing here ever calls the order API) ----------
const LOT_SIZE_DEFAULT = 65; // NIFTY lot size per NSE from Jan 2026 — editable on the ticket, verify before relying on P&L
const PAPER_STORAGE_KEY = "paper_trades_v1";

function loadPaperTrades() {
  try {
    const raw = localStorage.getItem(PAPER_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_e) {
    return [];
  }
}
function savePaperTrades(trades) {
  try {
    localStorage.setItem(PAPER_STORAGE_KEY, JSON.stringify(trades));
  } catch (_e) {
    /* storage unavailable — trades just won't persist across reloads */
  }
}

function buildBotInstruments(result) {
  if (!result?.levels) return [];
  const calls = [];
  const puts = [];
  result.levels.forEach((l) => {
    calls.push({ key: `call-${l.ce_strike}`, type: "call", strike: l.ce_strike, label: `${l.ce_strike} CE`, sub: `${l.name} sniper · CE leg`, dayClose: l.ce_close, dayHigh: l.ce_high, levelName: l.name, group: "Calls (CE)" });
    puts.push({ key: `put-${l.pe_strike}`, type: "put", strike: l.pe_strike, label: `${l.pe_strike} PE`, sub: `${l.name} sniper · PE leg`, dayClose: l.pe_close, dayHigh: l.pe_high, levelName: l.name, group: "Puts (PE)" });
  });
  calls.sort((a, b) => a.strike - b.strike);
  puts.sort((a, b) => a.strike - b.strike);
  return [{ key: "spot", type: "spot", strike: null, label: "NIFTY 50", sub: "Index spot · reference", levelName: null, group: "Index" }, ...calls, ...puts];
}

// Tracks the pixel width of an element so the SVG chart can be drawn 1:1 (crisp text at any screen size)
function useElementWidth(fallback = 1000) {
  const ref = useRef(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = () => {
      const cw = Math.floor(el.clientWidth) - 18; // minus the card's padding/border
      if (cw > 300) setW(cw);
    };
    update();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// Live quotes for the watchlist (read-only quote calls; ~7 Breeze calls per refresh, so keep pollMs >= 5000).
// If one contract errors on a refresh, its last good price is kept and flagged "stale".
function useBotQuotes(expiry, instruments, pollMs = 10000) {
  const [quotes, setQuotes] = useState({});
  const [error, setError] = useState(null);
  const instRef = useRef(instruments);
  instRef.current = instruments;
  const sig = instruments.map((i) => i.key).join("|");

  const refresh = useCallback(async () => {
    const list = instRef.current;
    if (!expiry || list.length === 0) return;
    try {
      const data = await api("/api/bot/quotes", {
        method: "POST",
        body: JSON.stringify({ expiry, contracts: list.map((i) => ({ key: i.key, type: i.type, strike: i.strike })) }),
      });
      setQuotes((prev) => {
        const next = {};
        (data.quotes || []).forEach((q) => {
          const old = prev[q.key];
          next[q.key] = q.error && old && Number.isFinite(Number(old.ltp)) ? { ...old, stale: true, error: q.error } : q;
        });
        return next;
      });
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [expiry]);

  useEffect(() => {
    if (!sig) return undefined;
    setQuotes({});
    refresh();
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [sig, refresh, pollMs]);

  return { quotes, error, refresh };
}

// P&L: BUY first  -> (sell/exit price − buy price) × qty
//      SELL first -> (sell price − buy-back/exit price) × qty
const tradePnl = (t, price) => (t.side === "BUY" ? price - t.entryPrice : t.entryPrice - price) * t.qty;
const pnlFormula = (t, price) =>
  t.side === "BUY" ? `(${fmt2(price)} − ${fmt2(t.entryPrice)}) × ${t.qty}` : `(${fmt2(t.entryPrice)} − ${fmt2(price)}) × ${t.qty}`;
const isReal = (t) => t.mode === "REAL";
const rightOf = (t) => t.right || (String(t.key).startsWith("call") ? "call" : "put");

function buildTrade({ inst, expiry, side, lots, lotSize, price, sl, target, note, mode = "PAPER", setupId = null, triggerId = null }) {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    mode,
    setupId,
    triggerId,
    key: inst.key,
    strike: inst.strike,
    right: inst.type,
    symbol: `NIFTY ${inst.strike} ${inst.type === "call" ? "CE" : "PE"}`,
    expiry,
    side,
    lots,
    lotSize,
    qty: lots * lotSize,
    entryPrice: price,
    entryTime: new Date().toISOString(),
    sl,
    target,
    status: "OPEN",
    exitPrice: null,
    exitTime: null,
    exitReason: null,
    note: note || "",
  };
}

// ===================== bot entry setups =====================
// All four setups BUY an OTM option:  CE setups -> OTM CE (ATM+100), ATM PE is the "opposite" check
//                                     PE setups -> OTM PE (ATM−100), ATM CE is the "opposite" check
// "profit booking": OTM must be above its previous day CLOSE and above the ATM sniper value
// "panic"         : OTM must be above its previous day HIGH
// Entry: when the option price crosses the next perfect-square number above it (156 -> 13² = 169);
//        SL = slSquares squares lower (default 1 -> 12² = 144), target = tgtSquares squares higher (default 2 -> 15² = 225)
const SETUPS = [
  { id: "CE_PROFIT", name: "CE profit booking", dir: "CE", otm: "close" },
  { id: "CE_PANIC", name: "CE panic", dir: "CE", otm: "high" },
  { id: "PE_PROFIT", name: "PE profit booking", dir: "PE", otm: "close" },
  { id: "PE_PANIC", name: "PE panic", dir: "PE", otm: "high" },
];

const nextSquare = (p) => (Math.floor(Math.sqrt(p)) + 1) ** 2; // smallest perfect square strictly above p

function evaluateSetup(setup, ctx) {
  const { quotes, instByKey, atm, atmSniper, niftyClose, prevSrc } = ctx;
  const isCE = setup.dir === "CE";
  const oppKey = isCE ? `put-${atm}` : `call-${atm}`;
  const otmKey = isCE ? `call-${atm + 100}` : `put-${atm - 100}`;
  const oppName = isCE ? "ATM PE" : "ATM CE";
  const otmName = isCE ? "OTM CE" : "OTM PE";
  const ltpOf = (k) => Number(quotes[k]?.ltp);
  const prevOf = (k) => (prevSrc === "quote" ? Number(quotes[k]?.prev_close) : k === "spot" ? Number(niftyClose) : Number(instByKey[k]?.dayClose));
  const checks = [];
  // a missing / NaN price makes a check fail, so the bot never trades on incomplete data
  const add = (label, ok, detail) => checks.push({ label, ok: ok === true, detail });

  const sp = ltpOf("spot");
  const spPrev = prevOf("spot");
  add(isCE ? "NIFTY above previous day close" : "NIFTY below previous day close", isCE ? sp > spPrev : sp < spPrev, `${fmt2(sp)} vs ${fmt2(spPrev)}`);

  const op = ltpOf(oppKey);
  const opPrev = prevOf(oppKey);
  add(`${oppName} ${oppKey.split("-")[1]} below previous day close`, op < opPrev, `${fmt2(op)} vs ${fmt2(opPrev)}`);
  add(`${oppName} below ATM sniper value`, op < atmSniper, `${fmt2(op)} vs ${fmt2(atmSniper)}`);

  const tp = ltpOf(otmKey);
  if (setup.otm === "close") {
    const tPrev = prevOf(otmKey);
    add(`${otmName} ${otmKey.split("-")[1]} above previous day close`, tp > tPrev, `${fmt2(tp)} vs ${fmt2(tPrev)}`);
    add(`${otmName} above ATM sniper value`, tp > atmSniper, `${fmt2(tp)} vs ${fmt2(atmSniper)}`);
  } else {
    const hi = Number(instByKey[otmKey]?.dayHigh);
    add(`${otmName} ${otmKey.split("-")[1]} above previous day high`, tp > hi, `${fmt2(tp)} vs ${fmt2(hi)}`);
  }
  return { id: setup.id, name: setup.name, entryKey: otmKey, entryLabel: otmName, entryLtp: tp, checks, pass: checks.every((c) => c.ok) };
}

function ModeSwitch({ on, onClick, label, sub, danger, disabled, title }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={"mode-btn " + (on ? "on " : "") + (danger ? "danger" : "")} onClick={onClick} disabled={disabled} title={title}>
      <span className="mode-knob" />
      <span>
        <span className="mode-label">{label}</span>
        <span className="mode-sub">{sub}</span>
      </span>
    </button>
  );
}

const LEVEL_CHIPS = [["ATM", "ATM"], ["ATM+1", "ATM+1"], ["ATM-1", "ATM-1"], ["ALL", "All"], ["OFF", "Off"]];

function TradingBotPage({ onBack }) {
  const { expiry, setExpiry, atmInput, setAtmInput, status, error, result, loadedExpiry, calculate, resetToAuto } = useSniperLevels();

  // ----- trades: PAPER (simulated, browser only) and REAL (sent to ICICI through the backend) -----
  const [trades, setTrades] = useState(loadPaperTrades);
  useEffect(() => {
    savePaperTrades(trades);
  }, [trades]);
  const hasRealOpen = trades.some((t) => t.status === "OPEN" && isReal(t));

  const instruments = useMemo(() => buildBotInstruments(result), [result]);
  const instByKey = useMemo(() => Object.fromEntries(instruments.map((i) => [i.key, i])), [instruments]);
  const optionInsts = instruments.filter((i) => i.type !== "spot");
  const { quotes, error: quotesError } = useBotQuotes(loadedExpiry, instruments, hasRealOpen ? 6000 : 10000);

  // ----- mode switches: 1 only paper · 2 activate BOT · 3 activate real · 4 paper + real -----
  const [modePaper, setModePaper] = useState(true);
  const [botOn, setBotOn] = useState(false);
  const [modeReal, setModeReal] = useState(false);
  const [modeBoth, setModeBoth] = useState(false);
  const [realArmed, setRealArmed] = useState(false); // must be confirmed by typing REAL each time the page is opened
  const [realConfirm, setRealConfirm] = useState(null);
  const [realStatus, setRealStatus] = useState({ loaded: false, enabled: false, max_qty: 0 });
  const paperDest = modePaper || modeBoth;
  const realDest = modeReal || modeBoth;
  const realLive = realDest && realArmed && realStatus.enabled;

  useEffect(() => {
    api("/api/bot/real-status")
      .then((s) => setRealStatus({ loaded: true, enabled: !!s.enabled, max_qty: Number(s.max_qty) || 0 }))
      .catch(() => setRealStatus({ loaded: true, enabled: false, max_qty: 0 }));
  }, []);

  // ----- bot settings + activity log -----
  const [botLots, setBotLots] = useState("1");
  const [maxEntries, setMaxEntries] = useState("1");
  const [slSquares, setSlSquares] = useState("1");
  const [tgtSquares, setTgtSquares] = useState("2");
  const [prevSrc, setPrevSrc] = useState("candle"); // previous-day close from the daily candle (same as sniper) or from the live quote
  const [setupOn, setSetupOn] = useState({ CE_PROFIT: true, CE_PANIC: true, PE_PROFIT: true, PE_PANIC: true });
  const [armedView, setArmedView] = useState({});
  const [log, setLog] = useState([]);
  const botRef = useRef({ armed: {}, fired: {}, pending: {}, taken: new Set() });
  const exitingRef = useRef(new Set());
  const exitFails = useRef({});
  const logEvent = useCallback((kind, msg) => {
    setLog((prev) => [{ id: Date.now() + Math.random(), time: new Date().toISOString(), kind, msg }, ...prev].slice(0, 80));
  }, []);

  // ----- chart -----
  const [selectedKey, setSelectedKey] = useState("spot");
  const [interval, setIntervalState] = useState("5minute");
  const [levelSel, setLevelSel] = useState("ATM"); // which sniper level's lines to draw: ATM | ATM+1 | ATM-1 | ALL | OFF
  const [candles, setCandles] = useState([]);
  const [candlesLoading, setCandlesLoading] = useState(false);
  const [candlesError, setCandlesError] = useState(null);
  const [chartRef, chartW] = useElementWidth(1000);
  const selectedInst = instruments.find((i) => i.key === selectedKey) || instruments[0];

  useEffect(() => {
    if (!selectedInst || !loadedExpiry) return undefined;
    let cancelled = false;
    const load = () => {
      const qs =
        selectedInst.type === "spot"
          ? `stock_code=NIFTY&exchange_code=NSE&product_type=cash&interval=${interval}`
          : `stock_code=NIFTY&exchange_code=NFO&product_type=options&expiry=${loadedExpiry}&right=${selectedInst.type}&strike=${selectedInst.strike}&interval=${interval}`;
      setCandlesLoading(true);
      api(`/api/candles?${qs}`)
        .then((d) => {
          if (cancelled) return;
          setCandles(d.candles || []);
          setCandlesError(null);
        })
        .catch((e) => {
          if (!cancelled) setCandlesError(e.message);
        })
        .finally(() => {
          if (!cancelled) setCandlesLoading(false);
        });
    };
    load();
    const t = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [selectedInst, interval, loadedExpiry]);

  // Horizontal lines for the chosen sniper level(s):
  //  - NIFTY chart  : upper band, lower band and the level's strike (index scale)
  //  - option chart : the level's sniper value (premium scale) and this contract's day close
  const allLevels = result?.levels || [];
  const shownLevels = levelSel === "OFF" ? [] : levelSel === "ALL" ? allLevels : allLevels.filter((l) => l.name === levelSel);
  const chartLines = [];
  if (selectedInst?.type === "spot") {
    shownLevels.forEach((l) => {
      if (l.upper_band != null) chartLines.push({ price: l.upper_band, label: `${l.name} upper ${fmt2(l.upper_band)}`, color: "var(--down)" });
      if (l.lower_band != null) chartLines.push({ price: l.lower_band, label: `${l.name} lower ${fmt2(l.lower_band)}`, color: "var(--up)" });
      if (levelSel !== "ALL") chartLines.push({ price: l.center, label: `${l.name} strike ${l.center}`, color: "var(--ink-dim)", dash: "2 3" });
    });
  } else if (selectedInst) {
    shownLevels.forEach((l) => {
      if (l.sniper_value != null) chartLines.push({ price: l.sniper_value, label: `${l.name} sniper ${fmt2(l.sniper_value)}`, color: "var(--accent)" });
    });
    if (selectedInst.dayClose != null) chartLines.push({ price: selectedInst.dayClose, label: `Day close ${fmt2(selectedInst.dayClose)}`, color: "var(--ink-dim)", dash: "2 3" });
  }

  // ----- manual paper ticket state -----
  const [tab, setTab] = useState("open");
  const [side, setSide] = useState("BUY");
  const [instKey, setInstKey] = useState("");
  const [lots, setLots] = useState("1");
  const [lotSize, setLotSize] = useState(String(LOT_SIZE_DEFAULT));
  const [entryPrice, setEntryPrice] = useState("");
  const [entryTouched, setEntryTouched] = useState(false); // false => the entry box follows the live price
  const [slInput, setSlInput] = useState("");
  const [targetInput, setTargetInput] = useState("");
  const [note, setNote] = useState("");
  const [ticketError, setTicketError] = useState("");

  // open-position editing / exiting
  const [editId, setEditId] = useState(null);
  const [editSl, setEditSl] = useState("");
  const [editTarget, setEditTarget] = useState("");
  const [editError, setEditError] = useState("");
  const [exitPrices, setExitPrices] = useState({});

  // default the ticket to the ATM sniper's CE leg whenever the contract list changes
  useEffect(() => {
    if (optionInsts.length === 0) return;
    if (!optionInsts.some((i) => i.key === instKey)) {
      const atmLevel = result?.levels?.[0];
      const preferred = atmLevel ? `call-${atmLevel.ce_strike}` : optionInsts[0].key;
      setInstKey(optionInsts.some((i) => i.key === preferred) ? preferred : optionInsts[0].key);
    }
  }, [optionInsts, instKey, result]);

  // choosing a contract (watchlist or ticket) selects it on the chart, in the ticket, and switches the sniper lines to its level
  function selectContract(key) {
    setSelectedKey(key);
    const inst = instruments.find((i) => i.key === key);
    if (!inst) return;
    if (inst.levelName) setLevelSel(inst.levelName);
    if (inst.type !== "spot") {
      setInstKey(key);
      setEntryTouched(false);
      setEntryPrice("");
    }
  }

  const liveFor = (t) => (t.expiry === loadedExpiry ? Number(quotes[t.key]?.ltp) : NaN);
  const liveSel = Number(quotes[instKey]?.ltp);
  const entryDisplay = entryTouched ? entryPrice : Number.isFinite(liveSel) ? liveSel.toFixed(2) : "";

  function addTrade(trade, uniqueOnly = false) {
    setTrades((prev) => {
      if (uniqueOnly && prev.some((t) => t.status === "OPEN" && t.key === trade.key && t.expiry === trade.expiry && t.mode === trade.mode)) return prev;
      return [...prev, trade];
    });
  }

  // ----- mode switch handlers -----
  function toggleMode(which) {
    if (which === "paper") return setModePaper((v) => !v);
    if (which === "bot") return setBotOn((v) => !v);
    const isReal3 = which === "real";
    const current = isReal3 ? modeReal : modeBoth;
    const setCurrent = isReal3 ? setModeReal : setModeBoth;
    const otherOn = isReal3 ? modeBoth : modeReal;
    if (current) {
      setCurrent(false);
      if (!otherOn) setRealArmed(false);
      return undefined;
    }
    if (!realStatus.enabled) return undefined; // locked on the server (button is disabled anyway)
    if (realArmed) return setCurrent(true);
    return setRealConfirm({ target: which, text: "" });
  }

  function confirmReal() {
    if (!realConfirm || realConfirm.text.trim() !== "REAL") return;
    setRealArmed(true);
    (realConfirm.target === "real" ? setModeReal : setModeBoth)(true);
    setRealConfirm(null);
    logEvent("signal", "REAL trading armed for this session — bot signals can now send live orders.");
  }

  function openPaperTrade() {
    setTicketError("");
    if (!paperDest) return setTicketError("Turn on switch 1 (only paper) or 4 (paper + real) to place manual paper trades.");
    const inst = optionInsts.find((i) => i.key === instKey);
    if (!inst) return setTicketError("Pick an option contract.");
    const nLots = parseInt(lots, 10);
    const nLotSize = parseInt(lotSize, 10);
    if (!(nLots > 0) || !(nLotSize > 0)) return setTicketError("Lots and lot size must be positive whole numbers.");
    const price = entryTouched && entryPrice !== "" ? Number(entryPrice) : liveSel;
    if (!Number.isFinite(price) || price <= 0) return setTicketError("No live price yet — wait for the quote or type an entry price.");
    const sl = slInput !== "" ? Number(slInput) : null;
    const target = targetInput !== "" ? Number(targetInput) : null;
    if ((sl !== null && !Number.isFinite(sl)) || (target !== null && !Number.isFinite(target))) return setTicketError("SL / target must be numbers.");
    if (side === "BUY") {
      if (sl !== null && sl >= price) return setTicketError("For a BUY, SL must be below the entry price.");
      if (target !== null && target <= price) return setTicketError("For a BUY, target must be above the entry price.");
    } else {
      if (sl !== null && sl <= price) return setTicketError("For a SELL, SL must be above the entry price.");
      if (target !== null && target >= price) return setTicketError("For a SELL, target must be below the entry price.");
    }
    addTrade(buildTrade({ inst, expiry: loadedExpiry, side, lots: nLots, lotSize: nLotSize, price, sl, target, note, mode: "PAPER" }));
    setEntryTouched(false);
    setEntryPrice("");
    setNote("");
    setTab("open");
  }

  function closeTrade(id, price, reason, extra = {}) {
    setTrades((prev) =>
      prev.map((t) => (t.id === id && t.status === "OPEN" ? { ...t, status: "CLOSED", exitPrice: price, exitTime: new Date().toISOString(), exitReason: reason, ...extra } : t))
    );
    setExitPrices((prev) => {
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
    if (editId === id) setEditId(null);
  }

  // best-effort lookup of the real fill price / status after an order is accepted
  async function refreshFill(tradeId, orderId, leg) {
    for (const wait of [2500, 7000]) {
      await new Promise((r) => setTimeout(r, wait));
      try {
        const s = await api(`/api/bot/order-status?order_id=${encodeURIComponent(orderId)}`);
        const st = String(s.status || "");
        const avg = Number(s.avg_price);
        const done = /execut|traded|complete|filled/i.test(st);
        const dead = /reject|cancel/i.test(st);
        setTrades((prev) =>
          prev.map((t) => {
            if (t.id !== tradeId) return t;
            const patch = leg === "entry" ? { entryStatus: st } : { exitStatus: st };
            if (done && Number.isFinite(avg) && avg > 0) {
              if (leg === "entry") patch.entryPrice = avg;
              else patch.exitPrice = avg;
              patch.fillVerified = true;
            }
            return { ...t, ...patch };
          })
        );
        if (dead) {
          if (leg === "entry") {
            setTrades((prev) => prev.filter((t) => t.id !== tradeId));
            logEvent("error", `REAL entry order ${orderId} was ${st} — no position was opened.`);
          } else {
            setTrades((prev) => prev.map((t) => (t.id === tradeId ? { ...t, status: "OPEN", exitPrice: null, exitTime: null, exitReason: null, exitOrderId: null } : t)));
            exitingRef.current.delete(tradeId);
            exitFails.current[tradeId] = (exitFails.current[tradeId] || 0) + 1;
            logEvent("error", `REAL EXIT order ${orderId} was ${st} — the position is STILL OPEN at the broker. Check the ICICI app.`);
          }
          return;
        }
        if (done) return;
      } catch (_e) {
        /* status lookup is best-effort */
      }
    }
  }

  // REAL exit = a market order in the opposite direction (bot-managed: this page must stay open)
  async function exitReal(t, price, reason) {
    if (exitingRef.current.has(t.id)) return;
    if ((exitFails.current[t.id] || 0) >= 3) return;
    exitingRef.current.add(t.id);
    try {
      const r = await api("/api/bot/real-order", {
        method: "POST",
        body: JSON.stringify({ expiry: t.expiry, right: rightOf(t), strike: t.strike, action: t.side === "BUY" ? "sell" : "buy", quantity: t.qty, order_type: "market", remark: `bot exit ${reason}`.slice(0, 20) }),
      });
      if (!r.ok) throw new Error(r.error || r.message || "order not accepted");
      closeTrade(t.id, price, reason, { exitOrderId: r.order_id, exitStatus: "SENT" });
      logEvent("signal", `REAL exit sent: ${t.symbol} ×${t.qty} (${reason}, order ${r.order_id})`);
      refreshFill(t.id, r.order_id, "exit");
    } catch (e) {
      exitFails.current[t.id] = (exitFails.current[t.id] || 0) + 1;
      logEvent("error", `REAL EXIT FAILED for ${t.symbol} (${reason}), attempt ${exitFails.current[t.id]}/3: ${e.message}. If it keeps failing, exit in the ICICI app.`);
      exitingRef.current.delete(t.id);
    }
  }

  // Exit = the opposite order: a BUY position is sold, a SELL position is bought back. Paper: typed exit price, else live LTP.
  function manualExit(t) {
    setEditError("");
    if (isReal(t)) {
      if (!window.confirm(`Send a REAL market ${t.side === "BUY" ? "SELL" : "BUY"} order for ${t.qty} × ${t.symbol}?`)) return;
      const live = liveFor(t);
      exitFails.current[t.id] = 0;
      exitReal(t, Number.isFinite(live) ? live : t.entryPrice, "Manual exit");
      return;
    }
    const typed = exitPrices[t.id];
    let price = typed !== undefined && typed !== "" ? Number(typed) : liveFor(t);
    if (!Number.isFinite(price)) {
      const asked = window.prompt(`No live price for ${t.symbol}. Enter the exit price:`);
      if (!asked) return;
      price = Number(asked);
    }
    if (!Number.isFinite(price) || price <= 0) {
      setEditError("Enter a valid exit price.");
      return;
    }
    closeTrade(t.id, price, "Manual exit");
  }

  function startEdit(t) {
    setEditId(t.id);
    setEditSl(t.sl != null ? String(t.sl) : "");
    setEditTarget(t.target != null ? String(t.target) : "");
    setEditError("");
  }

  // Edit SL / target of an open trade. Checked against the CURRENT price (so you can trail SL past entry to lock profit).
  function saveEdit(t) {
    const sl = editSl !== "" ? Number(editSl) : null;
    const target = editTarget !== "" ? Number(editTarget) : null;
    if ((sl !== null && !(sl > 0)) || (target !== null && !(target > 0))) return setEditError("SL / target must be positive numbers (leave blank for none).");
    const live = liveFor(t);
    const ref = Number.isFinite(live) ? live : t.entryPrice;
    if (t.side === "BUY") {
      if (sl !== null && sl >= ref) return setEditError(`For a BUY, SL must be below the current price (${fmt2(ref)}).`);
      if (target !== null && target <= ref) return setEditError(`For a BUY, target must be above the current price (${fmt2(ref)}).`);
    } else {
      if (sl !== null && sl <= ref) return setEditError(`For a SELL, SL must be above the current price (${fmt2(ref)}).`);
      if (target !== null && target >= ref) return setEditError(`For a SELL, target must be below the current price (${fmt2(ref)}).`);
    }
    setTrades((prev) => prev.map((x) => (x.id === t.id && x.status === "OPEN" ? { ...x, sl, target } : x)));
    setEditId(null);
    setEditError("");
  }

  // SL / target check on every quote refresh: PAPER trades close in the browser, REAL trades send an exit order
  useEffect(() => {
    trades.forEach((t) => {
      if (t.status !== "OPEN" || t.expiry !== loadedExpiry) return;
      const q = quotes[t.key];
      if (!q || q.stale) return;
      const ltp = Number(q.ltp);
      if (!Number.isFinite(ltp)) return;
      let reason = null;
      if (t.side === "BUY") {
        if (t.sl != null && ltp <= t.sl) reason = "SL hit";
        else if (t.target != null && ltp >= t.target) reason = "Target hit";
      } else if (t.sl != null && ltp >= t.sl) reason = "SL hit";
      else if (t.target != null && ltp <= t.target) reason = "Target hit";
      if (!reason) return;
      if (isReal(t)) exitReal(t, ltp, reason);
      else closeTrade(t.id, ltp, reason);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quotes, loadedExpiry]);

  // ----- bot: evaluate the four setups on every quote refresh -----
  const atmNum = Number(result?.atm);
  const atmSniper = Number(result?.levels?.find((l) => l.name === "ATM")?.sniper_value);
  const setupEvals = useMemo(
    () => (result ? SETUPS.map((s) => evaluateSetup(s, { quotes, instByKey, atm: atmNum, atmSniper, niftyClose: result.nifty_close, prevSrc })) : []),
    [result, quotes, instByKey, prevSrc, atmNum, atmSniper]
  );

  async function placeRealEntry({ inst, ev, ltp, sl, target, lots: nLots, lotSize: nLotSize, note: noteTxt, triggerId }) {
    const qty = nLots * nLotSize;
    if (qty > realStatus.max_qty) {
      logEvent("error", `REAL entry for ${ev.name} blocked: quantity ${qty} is above the server limit ${realStatus.max_qty}.`);
      return;
    }
    botRef.current.pending[ev.id] = true;
    try {
      const r = await api("/api/bot/real-order", {
        method: "POST",
        body: JSON.stringify({ expiry: loadedExpiry, right: inst.type, strike: inst.strike, action: "buy", quantity: qty, order_type: "market", remark: `bot ${ev.id}`.slice(0, 20) }),
      });
      if (!r.ok) throw new Error(r.error || r.message || "order not accepted");
      const trade = { ...buildTrade({ inst, expiry: loadedExpiry, side: "BUY", lots: nLots, lotSize: nLotSize, price: ltp, sl, target, note: noteTxt, mode: "REAL", setupId: ev.id, triggerId }), entryOrderId: r.order_id, entryStatus: "SENT" };
      setTrades((prev) => [...prev, trade]);
      logEvent("signal", `REAL BUY sent: ${trade.symbol} ×${qty} (order ${r.order_id}) · SL ${sl} · target ${target}`);
      refreshFill(trade.id, r.order_id, "entry");
    } catch (e) {
      logEvent("error", `REAL entry failed for ${ev.name}: ${e.message}`);
    } finally {
      botRef.current.pending[ev.id] = false;
    }
  }

  function fireSetup(ev, ltp, level) {
    const slSq = parseInt(slSquares, 10);
    const tgtSq = parseInt(tgtSquares, 10);
    const n = Math.round(Math.sqrt(level));
    const sl = (n - slSq) ** 2;
    const target = (n + tgtSq) ** 2;
    const nLots = parseInt(botLots, 10);
    const nLotSize = parseInt(lotSize, 10);
    const cap = parseInt(maxEntries, 10);
    if (!(slSq >= 1) || !(tgtSq >= 1) || !(n - slSq >= 1)) return logEvent("error", `${ev.name}: invalid SL/target squares — signal skipped.`);
    if (!(nLots > 0) || !(nLotSize > 0)) return logEvent("error", `${ev.name}: lots / lot size invalid — signal skipped.`);
    const today = new Date().toDateString();
    const todays = new Set(trades.filter((t) => t.setupId === ev.id && new Date(t.entryTime).toDateString() === today).map((t) => t.triggerId));
    if (todays.size >= (cap > 0 ? cap : 1)) return logEvent("info", `${ev.name}: signal ignored — max entries per day (${cap}) already used.`);
    const inst = instByKey[ev.entryKey];
    if (!inst) return logEvent("error", `${ev.name}: contract ${ev.entryKey} is not in the watchlist — signal skipped.`);
    // never stack a second position on a contract that already has one open (e.g. CE profit booking + CE panic firing together)
    const st = botRef.current;
    const tk = (m) => `${m}|${inst.key}|${loadedExpiry}`;
    const doPaper = paperDest && !st.taken.has(tk("PAPER"));
    const doReal = realLive && !st.taken.has(tk("REAL"));
    if (!doPaper && !doReal) return logEvent("info", `${ev.name}: signal skipped — a position on ${inst.label} is already open.`);
    const triggerId = Date.now().toString(36);
    const noteTxt = `${ev.name} · crossed ${level} · SL ${sl} · T ${target}`;
    logEvent("signal", `${ev.name}: ${inst.label} crossed ${level} (LTP ${fmt2(ltp)}) → BUY, SL ${sl}, target ${target}`);
    if (doPaper) {
      st.taken.add(tk("PAPER"));
      addTrade(buildTrade({ inst, expiry: loadedExpiry, side: "BUY", lots: nLots, lotSize: nLotSize, price: ltp, sl, target, note: noteTxt, mode: "PAPER", setupId: ev.id, triggerId }));
    }
    if (doReal) {
      st.taken.add(tk("REAL"));
      placeRealEntry({ inst, ev, ltp, sl, target, lots: nLots, lotSize: nLotSize, note: noteTxt, triggerId });
    }
    return undefined;
  }

  useEffect(() => {
    if (!botOn || !result) return;
    if (!paperDest && !realLive) return;
    const st = botRef.current;
    st.taken = new Set(trades.filter((t) => t.status === "OPEN").map((t) => `${isReal(t) ? "REAL" : "PAPER"}|${t.key}|${t.expiry}`));
    setupEvals.forEach((ev) => {
      if (!setupOn[ev.id]) {
        delete st.armed[ev.id];
        return;
      }
      if (!ev.pass) {
        if (st.armed[ev.id]) logEvent("info", `${ev.name}: conditions no longer met — disarmed.`);
        delete st.armed[ev.id];
        st.fired[ev.id] = false; // may fire again once conditions turn true again
        return;
      }
      if (st.fired[ev.id] || st.pending[ev.id]) return;
      const ltp = ev.entryLtp;
      if (!Number.isFinite(ltp) || ltp <= 0) return;
      let armed = st.armed[ev.id];
      if (!armed || ltp < (Math.sqrt(armed.level) - 1) ** 2) {
        armed = { level: nextSquare(ltp) };
        st.armed[ev.id] = armed;
        logEvent("info", `${ev.name}: conditions met, ${ev.entryLabel} @ ${fmt2(ltp)} — armed, entry on a move above ${armed.level}.`);
      }
      if (ltp >= armed.level) {
        st.fired[ev.id] = true;
        delete st.armed[ev.id];
        fireSetup(ev, ltp, armed.level);
      }
    });
    const view = Object.fromEntries(Object.entries(st.armed).map(([k, v]) => [k, v.level]));
    setArmedView((prev) => (JSON.stringify(prev) === JSON.stringify(view) ? prev : view));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quotes]);

  // when the bot is switched off, forget what was armed
  useEffect(() => {
    if (!botOn) {
      botRef.current.armed = {};
      setArmedView({});
    }
  }, [botOn]);

  // leaving the page with live exposure would leave positions without a stop
  useEffect(() => {
    if (!(hasRealOpen || (botOn && realLive))) return undefined;
    const h = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [hasRealOpen, botOn, realLive]);

  function stopAll() {
    const openReal = trades.filter((t) => t.status === "OPEN" && isReal(t));
    const msg = openReal.length
      ? `Stop the bot and send REAL market exit orders for ${openReal.length} open position(s)?`
      : "Stop the bot?";
    if (!window.confirm(msg)) return;
    setBotOn(false);
    openReal.forEach((t) => {
      exitFails.current[t.id] = 0;
      const live = liveFor(t);
      exitReal(t, Number.isFinite(live) ? live : t.entryPrice, "Kill switch");
    });
    logEvent("signal", "Kill switch used — bot stopped.");
  }

  // ----- summaries -----
  const openTrades = trades.filter((t) => t.status === "OPEN");
  const closedTrades = trades.filter((t) => t.status === "CLOSED");
  const summarize = (list) => {
    const open = list.filter((t) => t.status === "OPEN");
    const closed = list.filter((t) => t.status === "CLOSED");
    return {
      open: open.reduce((s, t) => {
        const p = liveFor(t);
        return Number.isFinite(p) ? s + tradePnl(t, p) : s;
      }, 0),
      realised: closed.reduce((s, t) => s + tradePnl(t, t.exitPrice), 0),
      nOpen: open.length,
      nClosed: closed.length,
      wins: closed.filter((t) => tradePnl(t, t.exitPrice) > 0).length,
    };
  };
  const paperS = summarize(trades.filter((t) => !isReal(t)));
  const realS = summarize(trades.filter(isReal));
  const pnlClass = (v) => (v > 0 ? "pos-up" : v < 0 ? "pos-down" : "");
  const orphanReal = trades.filter((t) => t.status === "OPEN" && isReal(t) && t.expiry !== loadedExpiry);

  // Trade sheet = order ledger: every trade adds an ENTRY leg, and exiting adds an opposite EXIT leg carrying the P&L
  const legs = trades
    .flatMap((t) => {
      const entry = { id: `${t.id}:in`, kind: "ENTRY", side: t.side, time: t.entryTime, price: t.entryPrice, t };
      if (t.status !== "CLOSED") return [entry];
      const exit = { id: `${t.id}:out`, kind: "EXIT", side: t.side === "BUY" ? "SELL" : "BUY", time: t.exitTime, price: t.exitPrice, pnl: tradePnl(t, t.exitPrice), t };
      return [entry, exit];
    })
    .sort((a, b) => new Date(b.time) - new Date(a.time) || (a.kind === "EXIT" ? -1 : 1));

  function exportCsv() {
    const header = ["Time", "Mode", "Instrument", "Expiry", "Leg", "Side", "Qty", "Price", "SL", "Target", "P&L", "Result", "Note"];
    const rows = legs.map((g) => [
      g.time, isReal(g.t) ? "REAL" : "PAPER", g.t.symbol, g.t.expiry, g.kind, g.side, g.t.qty, g.price, g.t.sl ?? "", g.t.target ?? "",
      g.kind === "EXIT" ? g.pnl.toFixed(2) : "", g.kind === "EXIT" ? g.t.exitReason : g.t.status === "OPEN" ? "OPEN" : "", (g.t.note || "").replace(/"/g, '""'),
    ]);
    const csv = [header, ...rows].map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `trades_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function clearClosed() {
    if (closedTrades.length === 0) return;
    if (window.confirm(`Delete ${closedTrades.length} closed trade(s) from this browser's history? (Nothing at the broker is affected.)`)) {
      setTrades((prev) => prev.filter((t) => t.status === "OPEN"));
    }
  }

  const groups = ["Index", "Calls (CE)", "Puts (PE)"];
  const destText = [paperDest && "PAPER", realLive && "REAL"].filter(Boolean).join(" + ") || "none";
  const modeBadge = (t) => <span className={isReal(t) ? "badge-real" : "badge-paper"}>{isReal(t) ? "REAL" : "PAPER"}</span>;
  const realQty = (parseInt(botLots, 10) || 0) * (parseInt(lotSize, 10) || 0);

  return (
    <div className="screen dashboard">
      <header className="topbar">
        <div className="brand small">
          <div className="brand-mark">S</div>
          <span className="brand-name">STRAMESHRAJA · TRADING BOT</span>
        </div>
        <div className="topbar-right">
          <span className={realLive ? "paper-badge live" : "paper-badge"}>{realLive ? "REAL TRADING ARMED" : "PAPER TRADING · no orders are sent"}</span>
          <button className="secondary-btn compact" onClick={onBack}>
            <ArrowLeft size={14} /> Back to dashboard
          </button>
        </div>
      </header>

      <div className="bot-grid">
        {/* ---------------- left: levels controls + watchlist ---------------- */}
        <aside className="bot-left">
          <div className="panel-title">Setup</div>
          <form
            className="ticket-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              calculate(atmInput.trim());
            }}
            style={{ marginBottom: 14 }}
          >
            <label className="field">
              <span>Option expiry</span>
              <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
            </label>
            <label className="field">
              <span>ATM strike (blank = auto)</span>
              <input type="number" step="50" placeholder="auto from NIFTY close" value={atmInput} onChange={(e) => setAtmInput(e.target.value)} />
            </label>
            <div className="two-col">
              <button className="connect-btn" type="submit" disabled={status === "loading"} style={{ margin: 0 }}>
                {status === "loading" ? "Loading…" : "Load"}
              </button>
              <button type="button" className="secondary-btn" onClick={resetToAuto} disabled={status === "loading"} style={{ justifyContent: "center", width: "100%" }}>
                Auto ATM
              </button>
            </div>
            {status === "error" && <div className="error-line">{error}</div>}
          </form>

          <div className="panel-title">Watchlist · sniper contracts</div>
          {result && (
            <div className="wl-meta">
              ATM {result.atm}
              {result.is_manual_atm ? " (manual)" : " (auto)"} · Exp {result.expiry_date}
            </div>
          )}
          {quotesError && <div className="error-line" style={{ marginBottom: 6 }}>{quotesError}</div>}
          {instruments.length === 0 && <div className="pos-empty">{status === "loading" ? "Loading contracts…" : "Load the levels to build the watchlist."}</div>}

          {groups.map((g) => {
            const items = instruments.filter((i) => i.group === g);
            if (items.length === 0) return null;
            return (
              <div key={g}>
                <div className="wl-group">{g}</div>
                <div className="watchlist-rows">
                  {items.map((i) => {
                    const q = quotes[i.key] || {};
                    const ltp = Number(q.ltp);
                    const prev = Number(q.prev_close);
                    const hasChg = Number.isFinite(ltp) && Number.isFinite(prev) && prev !== 0;
                    const chg = hasChg ? ((ltp - prev) / prev) * 100 : null;
                    const up = chg !== null && chg >= 0;
                    return (
                      <button key={i.key} className={"watch-row " + (selectedInst?.key === i.key ? "selected" : "")} onClick={() => selectContract(i.key)}>
                        <div className="watch-left">
                          <div className="watch-sym">{i.label}</div>
                          <div className="watch-name">{i.sub}</div>
                          {i.dayClose != null && <div className="watch-name">Day close {fmt2(i.dayClose)}</div>}
                          {q.error && (
                            <div className="watch-err" title={q.error}>
                              {q.stale ? "stale · " : ""}
                              {String(q.error).slice(0, 42)}
                            </div>
                          )}
                        </div>
                        <div className="watch-right">
                          <div className="watch-price" style={q.stale ? { opacity: 0.55 } : undefined}>{Number.isFinite(ltp) ? ltp.toFixed(2) : q.error ? "err" : "—"}</div>
                          {chg !== null && (
                            <div className={"watch-chg " + (up ? "up" : "down")}>
                              {up ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}
                              {Math.abs(chg).toFixed(2)}%
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </aside>

        {/* ---------------- centre: mode switches, wide chart, sheets ---------------- */}
        <main className="bot-center">
          {/* ===== trading mode switches ===== */}
          <div className="mode-bar">
            <div className="mode-switches">
              <ModeSwitch on={modePaper} onClick={() => toggleMode("paper")} label="1 · Only paper trade" sub="manual paper trades allowed" />
              <ModeSwitch on={botOn} onClick={() => toggleMode("bot")} label="2 · Activate BOT" sub="trade on the entry conditions" />
              <ModeSwitch
                on={modeReal}
                danger
                onClick={() => toggleMode("real")}
                disabled={!realStatus.enabled}
                label="3 · Activate real trade"
                sub={realStatus.enabled ? "bot sends live orders" : "locked on the server"}
                title={realStatus.enabled ? "" : "Set ENABLE_REAL_TRADING=1 in the backend .env and restart Flask to unlock"}
              />
              <ModeSwitch
                on={modeBoth}
                danger
                onClick={() => toggleMode("both")}
                disabled={!realStatus.enabled}
                label="4 · Paper + real trade"
                sub={realStatus.enabled ? "bot trades both" : "locked on the server"}
                title={realStatus.enabled ? "" : "Set ENABLE_REAL_TRADING=1 in the backend .env and restart Flask to unlock"}
              />
            </div>
            <div className="mode-status">
              Manual paper trades: <b>{paperDest ? "ON" : "OFF"}</b> · BOT: <b>{botOn ? "ON" : "OFF"}</b> · Bot trades go to: <b>{destText}</b>
              {botOn && destText === "none" && <span className="mode-warn"> — BOT is on but no destination is active (turn on 1, 3 or 4)</span>}
              {realStatus.loaded && !realStatus.enabled && <span> · Real trading is locked: set ENABLE_REAL_TRADING=1 in the backend .env and restart.</span>}
              {(botOn || hasRealOpen) && (
                <button className="kill-btn" onClick={stopAll}>
                  {hasRealOpen ? "STOP BOT + EXIT ALL REAL" : "Stop bot"}
                </button>
              )}
            </div>

            {realConfirm && (
              <div className="real-confirm">
                <b>Enable REAL order placement?</b> When a setup triggers, the bot will send <b>live market BUY orders</b> for NIFTY options to your ICICI account
                ({parseInt(botLots, 10) || 0} lot × {parseInt(lotSize, 10) || 0} = <b>{realQty}</b> qty per trade; server limit {realStatus.max_qty}), and market exit orders at SL / target.
                Exits are checked by <b>this page</b> every few seconds — if you close the tab or lose connection, open positions have <b>no stop</b>.
                <div className="two-col" style={{ marginTop: 8, gridTemplateColumns: "1fr auto auto" }}>
                  <input
                    className="cell-input"
                    style={{ width: "100%" }}
                    placeholder="type REAL to confirm"
                    value={realConfirm.text}
                    onChange={(e) => setRealConfirm({ ...realConfirm, text: e.target.value })}
                  />
                  <button className="secondary-btn compact" onClick={confirmReal} disabled={realConfirm.text.trim() !== "REAL"}>Enable</button>
                  <button className="secondary-btn compact" onClick={() => setRealConfirm(null)}>Cancel</button>
                </div>
              </div>
            )}
          </div>

          {orphanReal.length > 0 && (
            <div className="warn-box">
              <div className="warn-line">
                {orphanReal.length} open REAL position(s) are for an expiry other than the loaded one ({loadedExpiry}) — their SL/target are NOT being watched. Load expiry {orphanReal[0].expiry} to manage them.
              </div>
            </div>
          )}
          {result?.warnings?.length > 0 && (
            <div className="warn-box">
              {result.warnings.map((w, i) => (
                <div key={i} className="warn-line">{w}</div>
              ))}
            </div>
          )}

          {selectedInst ? (
            <>
              <div className="bot-sel-head">
                <div>
                  <div className="bot-sel-name">{selectedInst.label}</div>
                  <div className="bot-sel-sub">{selectedInst.sub}</div>
                </div>
                <div className="bot-sel-price">{fmt2(quotes[selectedInst.key]?.ltp)}</div>
              </div>

              <div className="interval-row">
                {["1minute", "5minute", "30minute", "1day"].map((iv) => (
                  <button key={iv} className={"interval-btn " + (interval === iv ? "active" : "")} onClick={() => setIntervalState(iv)}>
                    {{ "1minute": "1m", "5minute": "5m", "30minute": "30m", "1day": "1D" }[iv]}
                  </button>
                ))}
                {candlesLoading && <Loader2 size={13} className="spin-icon" style={{ marginLeft: 6 }} />}
                <span className="chip-gap" />
                <span className="wl-meta" style={{ margin: 0 }}>Sniper lines</span>
                {LEVEL_CHIPS.map(([k, label]) => (
                  <button key={k} className={"interval-btn " + (levelSel === k ? "active" : "")} onClick={() => setLevelSel(k)}>{label}</button>
                ))}
              </div>
              <div className="wl-meta" style={{ marginBottom: 6 }}>
                {selectedInst.type === "spot"
                  ? "NIFTY chart: red = sniper upper, green = sniper lower, dotted = level strike. Lines outside the visible price range show as ▲ / ▼ markers."
                  : "Option chart (premium scale): orange = sniper value of the chosen level, dotted = this contract's day close."}
              </div>

              <div className="chart-wide" ref={chartRef}>
                {candlesError ? (
                  <div className="error-line" style={{ padding: 12 }}>{candlesError}</div>
                ) : (
                  <CandlestickChart candles={candles} width={chartW} height={430} levels={chartLines} />
                )}
              </div>
            </>
          ) : (
            <div className="pos-empty">Load the sniper levels to start.</div>
          )}

          <div className="bot-tabs">
            {[["open", `Open positions (${openTrades.length})`], ["sheet", `Trade sheet (${legs.length})`], ["bot", "Bot conditions & log"], ["levels", "Sniper levels"]].map(([k, label]) => (
              <button key={k} className={"interval-btn " + (tab === k ? "active" : "")} onClick={() => setTab(k)}>{label}</button>
            ))}
            {tab === "sheet" && (
              <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                <button className="secondary-btn compact" onClick={exportCsv} disabled={trades.length === 0}><Download size={13} /> CSV</button>
                <button className="secondary-btn compact" onClick={clearClosed} disabled={closedTrades.length === 0}><Trash2 size={13} /> Clear closed</button>
              </span>
            )}
          </div>

          {tab === "open" && (
            openTrades.length === 0 ? (
              <div className="pos-empty">No open positions.</div>
            ) : (
              <>
                {editError && <div className="error-line" style={{ marginBottom: 8 }}>{editError}</div>}
                <div className="sr-scroll">
                  <table className="sr-table">
                    <thead>
                      <tr><th>Instrument</th><th>Side</th><th>Qty</th><th>Entry</th><th>LTP</th><th>P&amp;L</th><th>SL</th><th>Target</th><th>Exit price</th><th></th></tr>
                    </thead>
                    <tbody>
                      {openTrades.map((t) => {
                        const p = liveFor(t);
                        const pnl = Number.isFinite(p) ? tradePnl(t, p) : null;
                        const editing = editId === t.id;
                        return (
                          <tr key={t.id}>
                            <td>{t.symbol}{modeBadge(t)}<div className="watch-name">Exp {t.expiry}{t.setupId ? ` · ${SETUPS.find((s) => s.id === t.setupId)?.name || t.setupId}` : ""}</div></td>
                            <td className={t.side === "BUY" ? "pos-up" : "pos-down"}>{t.side}</td>
                            <td>{t.qty}</td>
                            <td>{fmt2(t.entryPrice)}<div className="watch-name">{isReal(t) ? (t.fillVerified ? "filled at" : "approx · " + (t.entryStatus || "sent")) : t.side === "SELL" ? "sold at" : "bought at"}</div></td>
                            <td>{Number.isFinite(p) ? p.toFixed(2) : "—"}</td>
                            <td className={pnl === null ? "" : pnlClass(pnl)}>
                              {pnl === null ? "—" : fmtSigned(pnl)}
                              {pnl !== null && <div className="watch-name">{pnlFormula(t, p)}</div>}
                            </td>
                            <td>
                              {editing ? (
                                <input className="cell-input" type="number" step="0.05" value={editSl} onChange={(e) => setEditSl(e.target.value)} placeholder="none" />
                              ) : t.sl != null ? fmt2(t.sl) : "—"}
                            </td>
                            <td>
                              {editing ? (
                                <input className="cell-input" type="number" step="0.05" value={editTarget} onChange={(e) => setEditTarget(e.target.value)} placeholder="none" />
                              ) : t.target != null ? fmt2(t.target) : "—"}
                            </td>
                            <td>
                              <input
                                className="cell-input"
                                type="number"
                                step="0.05"
                                placeholder={isReal(t) ? "market" : "live"}
                                disabled={isReal(t)}
                                value={exitPrices[t.id] ?? ""}
                                onChange={(e) => setExitPrices((prev) => ({ ...prev, [t.id]: e.target.value }))}
                              />
                            </td>
                            <td>
                              <span className="row-actions">
                                {editing ? (
                                  <>
                                    <button className="secondary-btn compact" onClick={() => saveEdit(t)}>Save</button>
                                    <button className="secondary-btn compact" onClick={() => { setEditId(null); setEditError(""); }}>Cancel</button>
                                  </>
                                ) : (
                                  <>
                                    <button className="secondary-btn compact" onClick={() => startEdit(t)}>Edit SL/Target</button>
                                    <button className="secondary-btn compact" onClick={() => manualExit(t)}>Exit {t.side === "SELL" ? "(buy back)" : "(sell)"}</button>
                                  </>
                                )}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )
          )}

          {tab === "sheet" && (
            legs.length === 0 ? (
              <div className="pos-empty">The trade sheet is empty.</div>
            ) : (
              <div className="sr-scroll">
                <table className="sr-table">
                  <thead>
                    <tr><th>Time</th><th>Instrument</th><th>Leg</th><th>Side</th><th>Qty</th><th>Price</th><th>SL</th><th>Target</th><th>P&amp;L</th><th>Result</th><th></th></tr>
                  </thead>
                  <tbody>
                    {legs.map((g) => (
                      <tr key={g.id} className={g.kind === "EXIT" ? (g.pnl >= 0 ? "sup" : "res") : ""}>
                        <td>{fmtTime(g.time)}</td>
                        <td>{g.t.symbol}{modeBadge(g.t)}<div className="watch-name">Exp {g.t.expiry}{g.kind === "ENTRY" && g.t.note ? ` · ${g.t.note}` : ""}</div></td>
                        <td>{g.kind}</td>
                        <td className={g.side === "BUY" ? "pos-up" : "pos-down"}>{g.side}</td>
                        <td>{g.t.qty}</td>
                        <td>{fmt2(g.price)}</td>
                        <td>{g.kind === "ENTRY" && g.t.sl != null ? fmt2(g.t.sl) : "—"}</td>
                        <td>{g.kind === "ENTRY" && g.t.target != null ? fmt2(g.t.target) : "—"}</td>
                        <td className={g.kind === "EXIT" ? pnlClass(g.pnl) : ""}>
                          {g.kind === "EXIT" ? fmtSigned(g.pnl) : "—"}
                          {g.kind === "EXIT" && <div className="watch-name">{pnlFormula(g.t, g.price)}</div>}
                        </td>
                        <td>{g.kind === "EXIT" ? g.t.exitReason : g.t.status === "OPEN" ? "OPEN" : ""}</td>
                        <td>
                          {g.kind === "EXIT" ? (
                            <button className="icon-btn" title="Delete this trade from history (entry + exit)" onClick={() => setTrades((prev) => prev.filter((x) => x.id !== g.t.id))}><X size={12} /></button>
                          ) : g.t.status === "OPEN" ? (
                            <button className="secondary-btn compact" onClick={() => manualExit(g.t)}>Exit</button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}

          {tab === "levels" && (result ? <SrTable levels={result.levels} reference={result.reference_price} /> : <div className="pos-empty">No levels loaded.</div>)}

          {tab === "bot" && (
            <div>
              <div className="wl-meta" style={{ marginBottom: 8 }}>
                Checked on every quote refresh while the BOT switch is on. A setup arms when all its checks pass, then enters when the option price crosses the next square number above it.
                Missing prices make a check fail, so the bot never trades on incomplete data.
              </div>
              {setupEvals.length === 0 ? (
                <div className="pos-empty">Load the sniper levels first.</div>
              ) : (
                setupEvals.map((ev) => {
                  const lvl = armedView[ev.id];
                  const n = lvl ? Math.round(Math.sqrt(lvl)) : null;
                  const slSq = parseInt(slSquares, 10) || 1;
                  const tgtSq = parseInt(tgtSquares, 10) || 2;
                  const state = !setupOn[ev.id] ? "Disabled" : !botOn ? (ev.pass ? "Conditions met (bot off)" : "Not met") : lvl ? `Armed · enter above ${lvl}` : ev.pass ? "Met" : "Not met";
                  return (
                    <div className="setup-card" key={ev.id}>
                      <div className="setup-head">
                        <span>{ev.name} <span className="watch-name" style={{ display: "inline" }}>· buys {ev.entryLabel} {ev.entryKey.split("-")[1]}</span></span>
                        <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <span className={"pill " + (ev.pass && setupOn[ev.id] ? "pill-on" : "")}>{state}</span>
                          <label className="auto-row" style={{ gap: 4 }}>
                            <input type="checkbox" checked={!!setupOn[ev.id]} onChange={(e) => setSetupOn((prev) => ({ ...prev, [ev.id]: e.target.checked }))} />
                            <span>enabled</span>
                          </label>
                        </span>
                      </div>
                      {ev.checks.map((c, i) => (
                        <div key={i} className={"chk " + (c.ok ? "ok" : "no")}>
                          <span>{c.ok ? "✓" : "✗"}</span>
                          <span>{c.label}</span>
                          <span style={{ marginLeft: "auto" }}>{c.detail}</span>
                        </div>
                      ))}
                      {lvl && <div className="chk ok" style={{ marginTop: 4 }}>Plan: BUY on a move above {lvl} · SL {(n - slSq) ** 2} · target {(n + tgtSq) ** 2}</div>}
                    </div>
                  );
                })
              )}

              <div className="panel-title" style={{ marginTop: 16 }}>Activity log</div>
              {log.length === 0 ? (
                <div className="pos-empty">No bot activity yet.</div>
              ) : (
                log.map((e) => (
                  <div key={e.id} className={"log-row " + e.kind}>
                    {fmtTime(e.time)} · {e.msg}
                  </div>
                ))
              )}
            </div>
          )}
        </main>

        {/* ---------------- right: P&L, manual paper ticket, bot settings ---------------- */}
        <aside className="bot-right">
          <div className="pnl-cards">
            <div className="pnl-card"><div className="k">Paper · open P&amp;L</div><div className={"v " + pnlClass(paperS.open)}>{fmtSigned(paperS.open)}</div></div>
            <div className="pnl-card"><div className="k">Paper · realised P&amp;L</div><div className={"v " + pnlClass(paperS.realised)}>{fmtSigned(paperS.realised)}</div></div>
            <div className="pnl-card"><div className="k">Real · open P&amp;L</div><div className={"v " + pnlClass(realS.open)}>{fmtSigned(realS.open)}</div></div>
            <div className="pnl-card"><div className="k">Real · realised P&amp;L</div><div className={"v " + pnlClass(realS.realised)}>{fmtSigned(realS.realised)}</div></div>
            <div className="pnl-card"><div className="k">Open trades</div><div className="v">{openTrades.length}</div></div>
            <div className="pnl-card"><div className="k">Closed (wins)</div><div className="v">{closedTrades.length} ({paperS.wins + realS.wins})</div></div>
          </div>
          {realS.nOpen + realS.nClosed > 0 && <div className="paper-note" style={{ marginTop: 6 }}>Real P&amp;L is an estimate from the prices seen by this page; fills are verified from the broker when available.</div>}

          <div className="panel-title" style={{ marginTop: 18 }}>Manual paper trade</div>
          <div className="ticket-form">
            <div className="seg">
              <button type="button" className={side === "BUY" ? "on buy" : ""} onClick={() => setSide("BUY")}>Buy</button>
              <button type="button" className={side === "SELL" ? "on sell" : ""} onClick={() => setSide("SELL")}>Sell</button>
            </div>

            <label className="field">
              <span>Option contract</span>
              <select value={instKey} onChange={(e) => selectContract(e.target.value)}>
                {optionInsts.map((i) => (
                  <option key={i.key} value={i.key}>{i.label} · {fmt2(quotes[i.key]?.ltp)}</option>
                ))}
              </select>
            </label>

            <div className="two-col">
              <label className="field"><span>Lots</span><input type="number" min="1" value={lots} onChange={(e) => setLots(e.target.value)} /></label>
              <label className="field"><span>Lot size</span><input type="number" min="1" value={lotSize} onChange={(e) => setLotSize(e.target.value)} /></label>
            </div>

            <label className="field">
              <span className="field-head">
                {side === "SELL" ? "Sell price" : "Buy price"} {entryTouched ? "(manual)" : "(live)"}
                {entryTouched && <button type="button" className="link-btn" onClick={() => { setEntryTouched(false); setEntryPrice(""); }}>use live</button>}
              </span>
              <input type="number" step="0.05" placeholder="waiting for live price…" value={entryDisplay} onChange={(e) => { setEntryTouched(true); setEntryPrice(e.target.value); }} />
            </label>

            <div className="two-col">
              <label className="field"><span>Stop-loss price</span><input type="number" step="0.05" value={slInput} onChange={(e) => setSlInput(e.target.value)} /></label>
              <label className="field"><span>Target price</span><input type="number" step="0.05" value={targetInput} onChange={(e) => setTargetInput(e.target.value)} /></label>
            </div>

            <label className="field"><span>Note (optional)</span><input type="text" value={note} onChange={(e) => setNote(e.target.value)} /></label>

            {ticketError && <div className="error-line">{ticketError}</div>}

            <button className="connect-btn" onClick={openPaperTrade} disabled={optionInsts.length === 0 || !paperDest}>
              Open paper {side.toLowerCase()} trade
            </button>
            <div className="paper-note">
              {paperDest ? "Simulated only — never sent to the broker. " : "Manual paper trading is off (switch 1 or 4). "}
              {side === "SELL" ? "A SELL is closed later by buying back; P&L = sell price − buy-back price." : "A BUY is closed later by selling; P&L = sell price − buy price."} SL / target can be edited in Open positions.
            </div>
          </div>

          <div className="panel-title" style={{ marginTop: 18 }}>Bot settings</div>
          <div className="ticket-form">
            <div className="two-col">
              <label className="field"><span>Bot lots</span><input type="number" min="1" value={botLots} onChange={(e) => setBotLots(e.target.value)} /></label>
              <label className="field"><span>Max entries / setup / day</span><input type="number" min="1" value={maxEntries} onChange={(e) => setMaxEntries(e.target.value)} /></label>
            </div>
            <div className="two-col">
              <label className="field"><span>SL = squares below</span><input type="number" min="1" value={slSquares} onChange={(e) => setSlSquares(e.target.value)} /></label>
              <label className="field"><span>Target = squares above</span><input type="number" min="1" value={tgtSquares} onChange={(e) => setTgtSquares(e.target.value)} /></label>
            </div>
            <label className="field">
              <span>Previous-day close taken from</span>
              <select value={prevSrc} onChange={(e) => setPrevSrc(e.target.value)}>
                <option value="candle">Daily candle (same as sniper levels)</option>
                <option value="quote">Live quote's previous close</option>
              </select>
            </label>
            <div className="paper-note">
              Bot quantity = lots × lot size = {realQty} per trade
              {realStatus.enabled ? ` (server limit ${realStatus.max_qty})` : ""}. Entry = next square above the option price (e.g. 156 → 13² = 169).
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ---------- dashboard ----------
function Dashboard({ sessionInfo, onDisconnect, onOpenIntraday, onOpenSniper, onOpenBot }) {
  const { rows, error, refresh } = useLiveWatchlist();
  const [selected, setSelected] = useState(null);
  const [side, setSide] = useState("buy");
  const [qty, setQty] = useState("1");
  const [orderType, setOrderType] = useState("market");
  const [limitPrice, setLimitPrice] = useState("");
  const [orderStatus, setOrderStatus] = useState(null);
  const [recentOrders, setRecentOrders] = useState([]);
  const [fundsOpen, setFundsOpen] = useState(false);
  const [fundsData, setFundsData] = useState(null);
  const [fundsLoading, setFundsLoading] = useState(false);
  const [fundsError, setFundsError] = useState(null);
  const [interval, setInterval_] = useState("1day");
  const [candles, setCandles] = useState([]);
  const [candlesLoading, setCandlesLoading] = useState(false);
  const [candlesError, setCandlesError] = useState(null);

  async function handleShowFunds() {
    setFundsOpen(true);
    setFundsLoading(true);
    setFundsError(null);
    try {
      const data = await api("/api/funds");
      setFundsData(data);
    } catch (e) {
      setFundsError(e.message);
    } finally {
      setFundsLoading(false);
    }
  }

  async function handleAddSymbol(item) {
    try {
      await api("/api/watchlist/add", {
        method: "POST",
        body: JSON.stringify({
          stock_code: item.stock_code,
          exchange_code: item.exchange_code,
          label: item.label,
          product_type: item.product_type || "cash",
        }),
      });
      await refresh();
      setSelected(item.stock_code);
    } catch (e) {
      // surfaced inline would need more state; keep it simple with an alert-free console log
      console.error("Failed to add symbol:", e.message);
    }
  }

  useEffect(() => {
    if (!selected && rows.length > 0) setSelected(rows[0].stock_code);
  }, [rows, selected]);

  const active = rows.find((r) => r.stock_code === selected);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setCandlesLoading(true);
    setCandlesError(null);
    api(
      `/api/candles?stock_code=${encodeURIComponent(active.stock_code)}&exchange_code=${encodeURIComponent(active.exchange_code)}&product_type=${encodeURIComponent(active.product_type || "cash")}&interval=${interval}`
    )
      .then((data) => {
        if (!cancelled) setCandles(data.candles || []);
      })
      .catch((e) => {
        if (!cancelled) setCandlesError(e.message);
      })
      .finally(() => {
        if (!cancelled) setCandlesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active?.stock_code, active?.exchange_code, interval]);

  async function handleDisconnect() {
    try {
      await api("/api/disconnect", { method: "POST" });
    } catch (e) {
      // ignore — we're leaving the screen regardless
    }
    onDisconnect();
  }

  async function placeOrder(e) {
    e.preventDefault();
    if (!active || !qty || +qty <= 0) return;
    setOrderStatus("submitting");
    const payload = {
      stock_code: active.stock_code,
      exchange_code: active.exchange_code,
      product: "cash",
      action: side,
      order_type: orderType,
      quantity: String(qty),
      price: orderType === "limit" ? String(limitPrice || "0") : "0",
      validity: "day",
      stoploss: "0",
    };
    try {
      const resp = await api("/api/orders", { method: "POST", body: JSON.stringify(payload) });
      setRecentOrders((o) => [{ ...payload, time: new Date(), result: resp }, ...o].slice(0, 8));
      setOrderStatus("placed");
    } catch (e) {
      setOrderStatus("error:" + e.message);
    }
  }

  return (
    <div className="screen dashboard">
      <header className="topbar">
        <div className="brand small">
          <div className="brand-mark">S</div>
          <span className="brand-name">STRAMESHRAJA</span>
        </div>
        <div className="topbar-right">
          {error ? (
            <span className="env-badge error"><WifiOff size={12} /> backend unreachable</span>
          ) : (
            <span className="env-badge live">LIVE</span>
          )}
          <button className="icon-btn" onClick={refresh} title="Refresh now">
            <RefreshCw size={14} />
          </button>
          <button className="secondary-btn compact" onClick={handleShowFunds}>
            <Wallet size={14} /> Funds
          </button>
          <button className="secondary-btn compact" onClick={onOpenIntraday}>
            <BarChart3 size={14} /> Intraday Range
          </button>
          <button className="secondary-btn compact" onClick={onOpenSniper}>
            <Target size={14} /> Sniper Levels
          </button>
          <button className="secondary-btn compact" onClick={onOpenBot}>
            <Bot size={14} /> Trading Bot
          </button>
          <button className="disconnect-btn" onClick={handleDisconnect}>
            <LogOut size={14} /> Disconnect
          </button>
        </div>
      </header>

      {error && (
        <div className="banner-error">
          Couldn't reach the backend at {API_BASE}: {error}. Make sure <code>python app.py</code> is running.
        </div>
      )}

      {fundsOpen && (
        <div className="funds-overlay" onClick={() => setFundsOpen(false)}>
          <div className="funds-panel" onClick={(e) => e.stopPropagation()}>
            <div className="funds-head">
              <div className="card-head">
                <Wallet size={16} /> <span>Funds</span>
              </div>
              <button className="icon-btn" onClick={() => setFundsOpen(false)}>
                <X size={14} />
              </button>
            </div>

            {fundsLoading && <div className="pos-empty">Fetching funds…</div>}
            {fundsError && <div className="error-line">{fundsError}</div>}

            {!fundsLoading && !fundsError && fundsData && (
              <FundsDisplay data={fundsData} />
            )}

            <button className="secondary-btn" style={{ marginTop: 10 }} onClick={handleShowFunds} disabled={fundsLoading}>
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
        </div>
      )}

      <div className="grid">
        <aside className="watchlist">
          <div className="panel-title">Watchlist</div>
          <AddSymbolBox onAdd={handleAddSymbol} />
          <div className="watchlist-rows">
            {rows.map((s) => {
              const ltp = Number(s.ltp);
              const prevClose = Number(s.prev_close);
              const chg = Number.isFinite(ltp) && Number.isFinite(prevClose) && prevClose !== 0 ? ((ltp - prevClose) / prevClose) * 100 : null;
              const up = chg === null ? true : chg >= 0;
              return (
                <button key={s.stock_code} className={"watch-row " + (s.stock_code === selected ? "selected" : "")} onClick={() => setSelected(s.stock_code)}>
                  <div className="watch-left">
                    <div className="watch-sym">{s.stock_code}</div>
                    <div className="watch-name">{s.label}</div>
                  </div>
                  <Sparkline data={s.history} positive={up} width={64} height={24} />
                  <div className="watch-right">
                    <div className="watch-price">{Number.isFinite(ltp) ? ltp.toFixed(2) : "—"}</div>
                    {chg !== null && (
                      <div className={"watch-chg " + (up ? "up" : "down")}>
                        {up ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                        {Math.abs(chg).toFixed(2)}%
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
            {rows.length === 0 && !error && <div className="pos-empty">Loading quotes…</div>}
          </div>
        </aside>

        <main className="chart-panel">
          {active && (
            <>
              <div className="chart-head">
                <div>
                  <div className="chart-sym">{active.stock_code}</div>
                  <div className="chart-name">{active.label}</div>
                </div>
                <div className="chart-price-block">
                  <div className="chart-price">{Number.isFinite(Number(active.ltp)) ? Number(active.ltp).toFixed(2) : "—"}</div>
                </div>
              </div>

              <div className="interval-row">
                {["1minute", "5minute", "30minute", "1day"].map((iv) => (
                  <button
                    key={iv}
                    className={"interval-btn " + (interval === iv ? "active" : "")}
                    onClick={() => setInterval_(iv)}
                  >
                    {{ "1minute": "1m", "5minute": "5m", "30minute": "30m", "1day": "1D" }[iv]}
                  </button>
                ))}
                {candlesLoading && <Loader2 size={13} className="spin-icon" style={{ marginLeft: 6 }} />}
              </div>

              <div className="chart-big">
                {candlesError ? (
                  <div className="error-line" style={{ padding: 12 }}>{candlesError}</div>
                ) : (
                  <CandlestickChart candles={candles} width={800} height={260} />
                )}
              </div>
            </>
          )}
          {!active && rows.length === 0 && <div className="pos-empty">Loading watchlist…</div>}
        </main>

        <aside className="ticket">
          <div className="panel-title">Order ticket</div>
          <form onSubmit={placeOrder} className="ticket-form">
            <div className="segmented full">
              <button type="button" className={side === "buy" ? "active buy" : ""} onClick={() => setSide("buy")}>Buy</button>
              <button type="button" className={side === "sell" ? "active sell" : ""} onClick={() => setSide("sell")}>Sell</button>
            </div>

            <label className="field">
              <span>Symbol</span>
              <select value={selected || ""} onChange={(e) => setSelected(e.target.value)}>
                {rows.map((s) => (
                  <option key={s.stock_code} value={s.stock_code}>{s.stock_code}</option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Quantity</span>
              <input type="number" min="1" step="1" value={qty} onChange={(e) => setQty(e.target.value)} />
            </label>

            <label className="field">
              <span>Order type</span>
              <select value={orderType} onChange={(e) => setOrderType(e.target.value)}>
                <option value="market">Market</option>
                <option value="limit">Limit</option>
              </select>
            </label>

            {orderType === "limit" && (
              <label className="field">
                <span>Limit price</span>
                <input type="number" min="0" step="any" value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} />
              </label>
            )}

            {orderStatus && orderStatus.startsWith("error:") && (
              <div className="error-line">{orderStatus.replace("error:", "")}</div>
            )}
            {orderStatus === "placed" && <div className="success-line">Order sent to Breeze.</div>}

            <button type="submit" className={"submit-btn " + side} disabled={orderStatus === "submitting"}>
              {orderStatus === "submitting" ? "Placing…" : side === "buy" ? "Place buy order" : "Place sell order"}
            </button>
          </form>

          <div className="panel-title" style={{ marginTop: 18 }}>Recent orders (this session)</div>
          <div className="orders-list">
            {recentOrders.length === 0 && <div className="pos-empty">No orders placed this session.</div>}
            {recentOrders.map((o, i) => (
              <div className="order-row" key={i}>
                <span className={"order-side " + o.action}>{o.action.toUpperCase()}</span>
                <span>{o.stock_code}</span>
                <span>{o.quantity}</span>
                <span className="order-status">{o.result?.Status || o.result?.error ? "Error" : "Sent"}</span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ---------- root ----------
export default function TradingPortal() {
  const [sessionInfo, setSessionInfo] = useState(null);
  const [page, setPage] = useState("dashboard"); // 'dashboard' | 'intraday' | 'sniper' | 'bot'

  useEffect(() => {
    document.title = "Strameshraja Dashboard";
  }, []);

  return (
    <div className="portal-root">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap');

        :root {
          --bg: #f4f5f7; --panel: #ffffff; --panel-2: #eef0f3; --line: #dde1e7; --input-bg: #f7f8fa;
          --ink: #1c2128; --ink-dim: #6b7280; --accent: #c9862c; --accent-dim: #f0dcb8;
          --up: #1a9d63; --down: #d1373c;
          --font-display: 'Space Grotesk', sans-serif; --font-body: 'Inter', sans-serif; --font-mono: 'JetBrains Mono', monospace;
        }
        .portal-root * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; }
        body { display: block !important; place-items: initial !important; min-width: 0 !important; }
        #root { max-width: none !important; width: 100% !important; margin: 0 !important; padding: 0 !important; text-align: left !important; }
        .portal-root { text-align: left; }
        .portal-root { font-family: var(--font-body); color: var(--ink); background: var(--bg); min-height: 600px; width: 100%; }
        .screen { min-height: 600px; width: 100%; }

        .connect-screen { display: flex; align-items: center; justify-content: center; padding: 48px 20px; background: radial-gradient(circle at 50% 0%, rgba(201,134,44,0.10), transparent 60%), var(--bg); }
        .connect-wrap { display: flex; flex-direction: column; align-items: center; gap: 28px; width: 100%; max-width: 440px; }
        .brand { display: flex; align-items: center; gap: 12px; }
        .brand-mark { width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; background: var(--accent); color: #191203; font-family: var(--font-display); font-weight: 700; border-radius: 8px; font-size: 18px; }
        .brand-name { font-family: var(--font-display); font-weight: 600; letter-spacing: 0.06em; font-size: 18px; }
        .brand-sub { font-size: 11px; color: var(--ink-dim); letter-spacing: 0.04em; }
        .brand.small .brand-mark { width: 28px; height: 28px; font-size: 14px; border-radius: 6px; }
        .brand.small .brand-name { font-size: 14px; }

        .connect-card { width: 100%; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 26px; display: flex; flex-direction: column; gap: 14px; }
        .card-head { display: flex; align-items: center; gap: 8px; font-family: var(--font-display); font-size: 15px; font-weight: 600; color: var(--accent); }
        .card-copy { font-size: 12.5px; color: var(--ink-dim); line-height: 1.5; margin: -6px 0 4px; }
        .card-copy code { font-family: var(--font-mono); background: var(--input-bg); padding: 1px 5px; border-radius: 4px; }

        .step { display: flex; gap: 12px; align-items: flex-start; }
        .step-num { width: 22px; height: 22px; border-radius: 50%; background: var(--panel-2); border: 1px solid var(--line); display: flex; align-items: center; justify-content: center; font-family: var(--font-mono); font-size: 11px; color: var(--ink-dim); flex-shrink: 0; }
        .step-body { flex: 1; display: flex; flex-direction: column; gap: 8px; }
        .step-title { font-size: 12.5px; color: var(--ink-dim); }
        .secondary-btn { display: flex; align-items: center; gap: 6px; background: var(--panel-2); border: 1px solid var(--line); color: var(--ink); border-radius: 7px; padding: 8px 12px; font-size: 12.5px; cursor: pointer; width: fit-content; }
        .secondary-btn:hover { border-color: var(--accent); }

        .field { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; color: var(--ink-dim); }
        .field input, .field select { background: var(--input-bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; color: var(--ink); font-family: var(--font-mono); font-size: 13px; outline: none; }
        .field input:focus, .field select:focus { border-color: var(--accent); }

        .segmented { display: flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
        .segmented button { flex: 1; padding: 9px 0; background: transparent; border: none; color: var(--ink-dim); font-family: var(--font-body); font-size: 12.5px; font-weight: 500; cursor: pointer; border-right: 1px solid var(--line); }
        .segmented button:last-child { border-right: none; }
        .segmented button.active.buy { background: rgba(53,201,143,0.18); color: var(--up); }
        .segmented button.active.sell { background: rgba(242,85,90,0.18); color: var(--down); }

        .error-line { font-size: 12px; color: var(--down); }
        .success-line { font-size: 12px; color: var(--up); }

        .connect-btn { margin-top: 4px; background: var(--accent); color: #191203; border: none; border-radius: 8px; padding: 12px 0; font-family: var(--font-display); font-weight: 600; font-size: 13.5px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; }
        .connect-btn:disabled { opacity: 0.75; cursor: default; }
        .spinner { width: 13px; height: 13px; border-radius: 50%; border: 2px solid rgba(25,18,3,0.35); border-top-color: #191203; animation: spin 0.8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .card-foot { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--ink-dim); margin-top: 2px; }

        .dashboard { display: flex; flex-direction: column; }
        .topbar { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--panel); }
        .topbar-right { display: flex; align-items: center; gap: 12px; }
        .env-badge { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.06em; padding: 3px 8px; border-radius: 5px; display: flex; align-items: center; gap: 5px; }
        .env-badge.live { background: rgba(201,134,44,0.15); color: var(--accent); }
        .env-badge.error { background: rgba(242,85,90,0.15); color: var(--down); }
        .icon-btn { background: transparent; border: 1px solid var(--line); color: var(--ink-dim); border-radius: 7px; padding: 6px; cursor: pointer; display: flex; }
        .icon-btn:hover { color: var(--ink); }
        .disconnect-btn { display: flex; align-items: center; gap: 6px; background: transparent; border: 1px solid var(--line); color: var(--ink-dim); border-radius: 7px; padding: 6px 10px; font-size: 12px; cursor: pointer; }
        .disconnect-btn:hover { color: var(--ink); border-color: var(--ink-dim); }

        .banner-error { background: rgba(242,85,90,0.1); border-bottom: 1px solid rgba(242,85,90,0.3); color: var(--down); font-size: 12px; padding: 8px 20px; font-family: var(--font-mono); }
        .banner-error code { background: rgba(0,0,0,0.2); padding: 1px 5px; border-radius: 4px; }

        .secondary-btn.compact { padding: 6px 10px; font-size: 12px; }

        .funds-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: flex-start; justify-content: center; padding-top: 80px; z-index: 50; }
        .funds-panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 20px; width: 100%; max-width: 380px; }
        .funds-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
        .funds-rows { display: flex; flex-direction: column; gap: 6px; max-height: 320px; overflow-y: auto; }
        .funds-row { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; padding: 7px 9px; background: var(--panel-2); border-radius: 6px; }
        .funds-key { color: var(--ink-dim); text-transform: capitalize; }
        .funds-val { font-family: var(--font-mono); text-align: right; }

        .grid { display: grid; grid-template-columns: 240px 1fr 280px; gap: 1px; background: var(--line); flex: 1; }
        .watchlist, .chart-panel, .ticket { background: var(--bg); padding: 16px; overflow-y: auto; }
        .panel-title { font-family: var(--font-display); font-size: 11.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-dim); margin-bottom: 10px; }

        .watchlist-rows { display: flex; flex-direction: column; gap: 3px; }

        .add-symbol { position: relative; margin-bottom: 10px; }
        .add-symbol-input { display: flex; align-items: center; gap: 6px; background: var(--input-bg); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
        .add-symbol-input input { flex: 1; background: transparent; border: none; outline: none; color: var(--ink); font-size: 12px; font-family: var(--font-body); }
        .add-symbol-input svg:first-child { color: var(--ink-dim); flex-shrink: 0; }
        .spin-icon { animation: spin 1s linear infinite; color: var(--ink-dim); flex-shrink: 0; }
        .add-symbol-dropdown { position: absolute; top: calc(100% + 4px); left: 0; right: 0; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 4px; z-index: 20; max-height: 260px; overflow-y: auto; box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
        .add-symbol-option { display: flex; align-items: center; justify-content: space-between; width: 100%; background: transparent; border: none; padding: 8px 9px; border-radius: 6px; cursor: pointer; text-align: left; }
        .add-symbol-option:hover { background: var(--panel); }
        .add-symbol-code { font-family: var(--font-mono); font-size: 12px; font-weight: 600; }
        .add-symbol-label { font-size: 10.5px; color: var(--ink-dim); }
        .add-symbol-meta { font-size: 10px; color: var(--ink-dim); font-family: var(--font-mono); flex-shrink: 0; }

        .interval-row { display: flex; align-items: center; gap: 4px; margin: 10px 0; }
        .interval-btn { background: var(--panel); border: 1px solid var(--line); color: var(--ink-dim); border-radius: 6px; padding: 5px 10px; font-size: 11.5px; font-family: var(--font-mono); cursor: pointer; }
        .interval-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }
        .watch-row { display: flex; align-items: center; gap: 8px; background: transparent; border: 1px solid transparent; border-radius: 8px; padding: 8px; cursor: pointer; text-align: left; width: 100%; }
        .watch-row:hover { background: var(--panel); }
        .watch-row.selected { background: var(--panel-2); border-color: var(--line); }
        .watch-left { flex: 1; min-width: 0; }
        .watch-sym { font-family: var(--font-mono); font-size: 12.5px; font-weight: 600; }
        .watch-name { font-size: 10.5px; color: var(--ink-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .watch-right { text-align: right; }
        .watch-price { font-family: var(--font-mono); font-size: 12px; }
        .watch-chg { display: flex; align-items: center; gap: 2px; justify-content: flex-end; font-size: 10.5px; }
        .watch-chg.up { color: var(--up); } .watch-chg.down { color: var(--down); }

        .chart-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 8px; }
        .chart-sym { font-family: var(--font-display); font-size: 20px; font-weight: 600; }
        .chart-name { font-size: 12px; color: var(--ink-dim); }
        .chart-price { font-family: var(--font-mono); font-size: 24px; }
        .chart-big { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px; }
        .chart-big svg { width: 100%; height: 220px; }

        .pos-empty { font-size: 12px; color: var(--ink-dim); padding: 10px 4px; }

        .ticket-form { display: flex; flex-direction: column; gap: 12px; }
        .submit-btn { border: none; border-radius: 8px; padding: 11px 0; font-family: var(--font-display); font-weight: 600; font-size: 13px; cursor: pointer; color: #fff; }
        .submit-btn:disabled { opacity: 0.6; cursor: default; }
        .submit-btn.buy { background: var(--up); color: #06251a; }
        .submit-btn.sell { background: var(--down); color: #2a0708; }

        .orders-list { display: flex; flex-direction: column; gap: 4px; }
        .order-row { display: grid; grid-template-columns: 0.7fr 1fr 0.6fr 0.9fr; font-family: var(--font-mono); font-size: 11px; padding: 6px 8px; background: var(--panel); border-radius: 6px; align-items: center; }
        .order-side.buy { color: var(--up); } .order-side.sell { color: var(--down); }
        .order-status { color: var(--ink-dim); }

        .intraday-wrap { display: flex; flex-wrap: wrap; gap: 20px; padding: 24px; align-items: flex-start; }
        .intraday-form-card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 22px; width: 100%; max-width: 360px; display: flex; flex-direction: column; gap: 14px; }
        .intraday-result-card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 22px; flex: 1; min-width: 320px; }
        .warn-box { background: rgba(209,55,60,0.08); border: 1px solid rgba(209,55,60,0.25); border-radius: 8px; padding: 10px 12px; margin-bottom: 14px; display: flex; flex-direction: column; gap: 4px; }
        .warn-line { font-size: 11.5px; color: var(--down); }
        .range-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 16px; }
        .range-cell { background: var(--panel-2); border-radius: 8px; padding: 10px 12px; }
        .range-label { font-size: 10.5px; color: var(--ink-dim); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
        .range-value { font-family: var(--font-mono); font-size: 15px; font-weight: 600; }
        .lines-grid { display: flex; flex-direction: column; gap: 6px; }
        .line-row { display: flex; justify-content: space-between; padding: 10px 14px; border-radius: 8px; font-family: var(--font-mono); font-size: 13px; }
        .line-row.up { background: rgba(26,157,99,0.1); color: var(--up); }
        .line-row.down { background: rgba(209,55,60,0.1); color: var(--down); }
        .line-row.mid { background: var(--panel-2); color: var(--ink); font-weight: 600; }

        .sr-scroll { overflow-x: auto; }
        .sr-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
        .sr-table th { text-align: left; font-size: 10.5px; font-weight: 500; color: var(--ink-dim); text-transform: uppercase; letter-spacing: 0.04em; padding: 6px 10px; border-bottom: 1px solid var(--line); }
        .sr-table td { padding: 9px 10px; font-family: var(--font-mono); border-bottom: 1px solid var(--line); white-space: nowrap; }
        .sr-table tr.res td { background: rgba(209,55,60,0.08); }
        .sr-table tr.res td:last-child { color: var(--down); font-weight: 600; }
        .sr-table tr.sup td { background: rgba(26,157,99,0.10); }
        .sr-table tr.sup td:last-child { color: var(--up); font-weight: 600; }
        .sr-table tr.ref td { background: var(--panel-2); font-weight: 600; }

        .bot-grid { display: grid; grid-template-columns: minmax(270px, 310px) minmax(0, 1fr) minmax(330px, 380px); gap: 1px; background: var(--line); flex: 1; min-height: 680px; }
        .bot-left, .bot-center, .bot-right { background: var(--bg); padding: 16px; overflow-y: auto; min-width: 0; }
        .bot-center { padding: 18px 22px; }
        .bot-sel-head { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 4px; }
        .bot-sel-name { font-family: var(--font-display); font-size: 22px; font-weight: 600; }
        .bot-sel-sub { font-size: 12px; color: var(--ink-dim); }
        .bot-sel-price { font-family: var(--font-mono); font-size: 26px; }
        .chart-wide { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 8px; }
        .chart-wide svg { width: 100%; height: auto; display: block; }
        .bot-tabs { display: flex; align-items: center; gap: 4px; margin: 18px 0 10px; }
        .wl-group { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-dim); margin: 14px 0 5px; }
        .wl-meta { font-size: 11px; color: var(--ink-dim); font-family: var(--font-mono); margin-bottom: 4px; }
        .paper-badge { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.05em; padding: 4px 9px; border-radius: 5px; background: rgba(26,157,99,0.12); color: var(--up); }
        .paper-note { font-size: 11px; color: var(--ink-dim); }
        .pnl-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .pnl-card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
        .pnl-card .k { font-size: 10.5px; color: var(--ink-dim); margin-bottom: 3px; }
        .pnl-card .v { font-family: var(--font-mono); font-size: 15px; }
        .pos-up { color: var(--up); } .pos-down { color: var(--down); }
        .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .seg { display: flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
        .seg button { flex: 1; padding: 9px 0; border: none; background: var(--panel); color: var(--ink-dim); font-size: 12.5px; cursor: pointer; }
        .seg button.on.buy { background: rgba(26,157,99,0.15); color: var(--up); font-weight: 600; }
        .seg button.on.sell { background: rgba(209,55,60,0.12); color: var(--down); font-weight: 600; }
        .strategy-box { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px; font-size: 12px; color: var(--ink-dim); }
        .auto-row { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
        .bot-left .field input, .bot-left .field select, .bot-right .field input, .bot-right .field select { width: 100%; min-width: 0; }
        .two-col > * { min-width: 0; }
        .interval-row { flex-wrap: wrap; }
        .bot-tabs { flex-wrap: wrap; }
        .bot-tabs .interval-btn, .interval-row .interval-btn { white-space: nowrap; }
        .chip-gap { width: 14px; }
        .field-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
        .link-btn { background: none; border: none; color: var(--accent); font-size: 11px; cursor: pointer; padding: 0; }
        .watch-err { font-size: 10px; color: var(--down); }
        .cell-input { width: 86px; padding: 5px 7px; font-size: 12px; font-family: var(--font-mono); background: var(--input-bg); border: 1px solid var(--line); border-radius: 6px; color: var(--ink); }
        .row-actions { display: flex; gap: 6px; }
        .row-actions .secondary-btn { white-space: nowrap; }
        .mode-bar { border: 1px solid var(--line); background: var(--panel); border-radius: 12px; padding: 12px 14px; margin-bottom: 14px; }
        .mode-switches { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
        .mode-btn { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); cursor: pointer; text-align: left; color: var(--ink); min-width: 0; }
        .mode-knob { width: 30px; height: 16px; border-radius: 10px; background: var(--line); position: relative; flex: none; transition: background .15s; }
        .mode-knob::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; transition: left .15s; }
        .mode-btn.on { border-color: var(--up); background: rgba(26,157,99,0.08); }
        .mode-btn.on .mode-knob { background: var(--up); }
        .mode-btn.on .mode-knob::after { left: 16px; }
        .mode-btn.danger.on { border-color: var(--down); background: rgba(209,55,60,0.08); }
        .mode-btn.danger.on .mode-knob { background: var(--down); }
        .mode-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .mode-label { display: block; font-size: 12.5px; font-weight: 600; }
        .mode-sub { display: block; font-size: 10.5px; color: var(--ink-dim); }
        .mode-status { margin-top: 9px; font-size: 11.5px; color: var(--ink-dim); font-family: var(--font-mono); display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
        .mode-warn { color: var(--down); }
        .kill-btn { margin-left: auto; background: var(--down); color: #fff; border: none; border-radius: 6px; padding: 5px 10px; font-size: 11px; font-weight: 600; cursor: pointer; }
        .real-confirm { border: 1px solid var(--down); background: rgba(209,55,60,0.06); border-radius: 10px; padding: 12px; margin-top: 10px; font-size: 12px; line-height: 1.5; }
        .paper-badge.live { background: rgba(209,55,60,0.14); color: var(--down); }
        .badge-real, .badge-paper { font-size: 9.5px; padding: 1px 5px; border-radius: 4px; margin-left: 6px; font-family: var(--font-mono); }
        .badge-real { background: rgba(209,55,60,0.14); color: var(--down); }
        .badge-paper { background: var(--panel-2); color: var(--ink-dim); }
        .setup-card { border: 1px solid var(--line); background: var(--panel); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; }
        .setup-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; margin-bottom: 6px; flex-wrap: wrap; }
        .pill { font-size: 10.5px; padding: 2px 8px; border-radius: 10px; background: var(--panel-2); color: var(--ink-dim); font-weight: 500; }
        .pill.pill-on { background: rgba(26,157,99,0.14); color: var(--up); }
        .chk { display: flex; gap: 8px; font-family: var(--font-mono); font-size: 11.5px; padding: 2px 0; }
        .chk.ok { color: var(--up); }
        .chk.no { color: var(--ink-dim); }
        .log-row { font-family: var(--font-mono); font-size: 11.5px; padding: 4px 0; border-bottom: 1px solid var(--line); color: var(--ink-dim); }
        .log-row.signal { color: var(--accent); }
        .log-row.error { color: var(--down); }
        @media (max-width: 1100px) { .bot-grid { grid-template-columns: 1fr; } }
        @media (max-width: 1400px) { .mode-switches { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
        @media (max-width: 860px) { .grid { grid-template-columns: 1fr; } }
      `}</style>

      {!sessionInfo ? (
        <ConnectScreen onConnect={setSessionInfo} />
      ) : page === "intraday" ? (
        <IntradayRangePage onBack={() => setPage("dashboard")} />
      ) : page === "sniper" ? (
        <SniperLevelsPage onBack={() => setPage("dashboard")} />
      ) : page === "bot" ? (
        <TradingBotPage onBack={() => setPage("dashboard")} />
      ) : (
        <Dashboard
          sessionInfo={sessionInfo}
          onDisconnect={() => setSessionInfo(null)}
          onOpenIntraday={() => setPage("intraday")}
          onOpenSniper={() => setPage("sniper")}
          onOpenBot={() => setPage("bot")}
        />
      )}
    </div>
  );
}
