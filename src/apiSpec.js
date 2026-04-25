/**
 * Tiny in-memory API spec registry.
 * Endpoints register themselves at boot; /api/_docs returns the array.
 */

const endpoints = [];

function register(spec) {
  if (!spec || !spec.method || !spec.path) {
    throw new Error('register() requires at least { method, path }');
  }
  endpoints.push({
    method: String(spec.method).toUpperCase(),
    path: spec.path,
    summary: spec.summary || '',
    description: spec.description || '',
    tags: spec.tags || [],
    params: spec.params || null,
    query: spec.query || null,
    body: spec.body || null,
    responseExample: spec.responseExample === undefined ? null : spec.responseExample,
  });
}

function getSpec() {
  return endpoints.slice();
}

function clear() {
  endpoints.length = 0;
}

module.exports = { register, getSpec, clear };
