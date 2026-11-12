// Local-only request guard.
//
// This server edits files and runs commands, so it must only ever answer the
// browser on this computer:
//   * the Host header must be loopback (blocks DNS-rebinding);
//   * a request carrying a foreign Origin, or marked cross-site by the
//     browser, is refused (blocks other websites from driving the agent);
//   * state-changing calls must be JSON, which forces a CORS pre-flight for
//     any cross-origin caller.
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function hostName(hostHeader) {
  const h = String(hostHeader || "").trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0];
}

function originHost(origin) {
  try { return new URL(origin).hostname.toLowerCase(); } catch { return ""; }
}

function isLocalRequest({ host, origin, secFetchSite }) {
  if (!LOCAL_HOSTS.has(hostName(host))) return false;
  if (origin && !LOCAL_HOSTS.has(originHost(origin)) && !LOCAL_HOSTS.has("[" + originHost(origin) + "]")) return false;
  if (secFetchSite === "cross-site") return false;
  return true;
}

function localOnly(req, res, next) {
  const ok = isLocalRequest({
    host: req.headers.host,
    origin: req.headers.origin,
    secFetchSite: req.headers["sec-fetch-site"],
  });
  if (!ok) return res.status(403).json({ error: "This app only answers the browser on this computer." });
  if (req.method === "POST" && !req.is("application/json")) {
    return res.status(415).json({ error: "POST requests must be JSON." });
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
}

module.exports = { isLocalRequest, localOnly, hostName };
