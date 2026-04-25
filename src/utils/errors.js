/**
 * Structured error helpers. The bridge always returns:
 *   { error: true, message: "...", code?, details? }
 * Never leaks raw axios/Shopify payloads to callers.
 */

class BridgeError extends Error {
  constructor(message, { status = 500, code = 'BRIDGE_ERROR', details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function toErrorPayload(err) {
  if (err instanceof BridgeError) {
    const payload = { error: true, message: err.message, code: err.code };
    if (err.details !== undefined) payload.details = err.details;
    return { status: err.status, payload };
  }
  return {
    status: 500,
    payload: { error: true, message: err.message || 'Internal Server Error', code: 'INTERNAL' },
  };
}

function sendError(res, err) {
  const { status, payload } = toErrorPayload(err);
  res.status(status).json(payload);
}

module.exports = { BridgeError, toErrorPayload, sendError };
