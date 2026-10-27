// Tiny static file server so the browser test runs on a real http:// origin
// (avoids file:// / null-origin CORS quirks).
// Run:  node test/server.js   then open http://localhost:8000/test/browser-test.html

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PORT = 8000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    let filePath = path.join(ROOT, urlPath);
    if (filePath.endsWith(path.sep) || urlPath === "/") {
      filePath = path.join(ROOT, "index.html");
    }
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403); res.end("Forbidden"); return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end("Not found: " + urlPath); return; }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(filePath)] || "application/octet-stream" });
      res.end(data);
    });
  })
  .listen(PORT, () => {
    console.log(`Serving ${ROOT} at http://localhost:${PORT}/`);
    console.log(`Open http://localhost:${PORT}/test/browser-test.html`);
  });
