// Binance → market.json bridge.
//
// Runs on a GitHub Actions runner (which is free and, unlike a Cloudflare
// Worker, MAY be allowed to reach Binance). Fetches the 24h tickers + a daily
// kline per top coin, and writes market.json. The Cloudflare Worker then reads
// that JSON from raw.githubusercontent.com — no VPS, no paid proxy.
//
// If Binance geo-blocks the runner (HTTP 451/403 — GitHub runs on Azure US
// IPs), this script exits non-zero and the Action fails; that's the signal that
// the free-GitHub route won't work and we should stay on Bybit.

import { writeFileSync } from "node:fs";

const B = "https://api.binance.com/api/v3";
const UA = { headers: { accept: "application/json", "User-Agent": "cryptoedu-bridge/1.0" } };

// Skip stablecoins and leveraged tokens.
const STABLES = new Set(["USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "USDD", "PYUSD", "EURI", "AEUR", "USDE"]);
const tradable = (s) => !STABLES.has(s) && !/(UP|DOWN|BULL|BEAR)$/.test(s);

async function main() {
  const res = await fetch(`${B}/ticker/24hr`, UA);
  if (!res.ok) {
    console.error(`Binance /ticker/24hr -> ${res.status}`);
    console.error((await res.text()).slice(0, 300));
    process.exit(1); // Action fails -> we know Binance is blocked from GitHub.
  }
  const raw = await res.json();

  const coins = raw
    .filter((t) => t.symbol.endsWith("USDT"))
    .map((t) => ({ t, base: t.symbol.slice(0, -4) }))
    .filter(({ base }) => tradable(base))
    .map(({ t, base }) => ({
      symbol: base.toLowerCase(),
      name: base,
      price: Number(t.lastPrice),
      change_24h: Number(t.priceChangePercent),
      high_24h: Number(t.highPrice),
      low_24h: Number(t.lowPrice),
      volume_24h: Number(t.quoteVolume), // USDT-denominated 24h volume
      yesterday_volume: null,
    }))
    .filter((c) => c.volume_24h > 0 && c.price > 0)
    .sort((a, b) => b.volume_24h - a.volume_24h)
    .slice(0, 120);

  // Yesterday's 24h quote-volume for the top 60 (enough for spike + radar).
  // Binance klines are OLDEST-first: limit=2 -> [0]=yesterday, [1]=today.
  // Index 7 = quote-asset volume.
  const top = coins.slice(0, 60);
  await Promise.all(
    top.map(async (c) => {
      try {
        const k = await fetch(`${B}/klines?symbol=${c.symbol.toUpperCase()}USDT&interval=1d&limit=2`, UA);
        if (!k.ok) return;
        const rows = await k.json();
        if (Array.isArray(rows) && rows.length >= 2) c.yesterday_volume = Number(rows[0][7]);
      } catch {
        /* leave null; the Worker falls back gracefully */
      }
    })
  );

  const out = { updated_at: Date.now(), source: "binance", count: coins.length, coins };
  writeFileSync("market.json", JSON.stringify(out));
  const withYest = coins.filter((c) => c.yesterday_volume != null).length;
  console.log(`Wrote market.json: ${coins.length} coins, ${withYest} with yesterday_volume`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
