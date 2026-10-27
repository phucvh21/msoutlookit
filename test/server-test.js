// Server-side connectivity test for Reddit's JSON API.
// Run:  node test/server-test.js
//
// This mirrors what a small proxy would do: make the request from Node
// (outside the browser) with an explicit User-Agent, and inspect both the
// status code and the CORS headers Reddit returns.

const https = require("https");

const ENDPOINTS = [
  "https://www.reddit.com/r/programming.json?limit=1",
  "https://www.reddit.com/r/programming/hot.json?limit=1",
  "https://api.reddit.com/r/programming?limit=1",
  "https://old.reddit.com/r/programming.json?limit=1",
];

const USER_AGENTS = {
  "default (no UA set)": null,
  "browser-like": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  "descriptive app UA": "MSOutlookitTest/1.0 (connectivity diagnostic; by /u/yourname)",
};

function request(url, userAgent) {
  return new Promise((resolve) => {
    const headers = { Origin: "http://localhost:8000" };
    if (userAgent) headers["User-Agent"] = userAgent;
    const req = https.get(url, { headers, timeout: 15000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          acao: res.headers["access-control-allow-origin"] || "-",
          contentType: res.headers["content-type"] || "-",
          retryAfter: res.headers["retry-after"],
          location: res.headers["location"],
          sample: body.slice(0, 120).replace(/\s+/g, " "),
        });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: "TIMEOUT" }); });
    req.on("error", (e) => resolve({ status: "ERROR", sample: e.message }));
  });
}

(async () => {
  for (const url of ENDPOINTS) {
    console.log("\n=== " + url + " ===");
    for (const [label, ua] of Object.entries(USER_AGENTS)) {
      const r = await request(url, ua);
      console.log(`  [${label}] status=${r.status} acao=${r.acao} ct=${r.contentType}` +
        (r.retryAfter ? ` retry-after=${r.retryAfter}` : "") +
        (r.location ? ` location=${r.location}` : "") +
        (r.sample ? `\n      body: ${r.sample}` : ""));
    }
  }
  console.log("\nDone.");
})();
