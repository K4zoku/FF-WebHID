// HTTP status helper for NM protocol responses.
// Provides isOk() for 2xx check and name() for debug logging.
(function () {
  const isOk = (s) => typeof s === "number" && s >= 200 && s < 300;
  const NAME = {
    200: "OK",
    201: "Created",
    204: "No Content",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    422: "Unprocessable Entity",
    500: "Internal Server Error",
    503: "Service Unavailable",
  };
  const name = (s) => NAME[s] || "HTTP " + s;
  globalThis.__webhid = globalThis.__webhid || {};
  globalThis.__webhid.http = { isOk, name };
})();
