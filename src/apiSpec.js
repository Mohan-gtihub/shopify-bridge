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

function convertToOpenAPI(baseUrl = 'http://localhost:3000') {
  const paths = {};
  const tags = new Set();

  endpoints.forEach(ep => {
    const p = ep.path.replace(/:(\w+)/g, '{$1}'); // Convert :id to {id}
    if (!paths[p]) paths[p] = {};

    const method = ep.method.toLowerCase();
    ep.tags.forEach(t => tags.add(t));

    const parameters = [];
    if (ep.params) {
      Object.entries(ep.params).forEach(([name, d]) => {
        parameters.push({ name, in: 'path', required: true, description: d.description || '', schema: { type: 'string' } });
      });
    }
    if (ep.query) {
      Object.entries(ep.query).forEach(([name, d]) => {
        parameters.push({ name, in: 'query', required: !!d.required, description: d.description || '', schema: { type: 'string' } });
      });
    }

    const op = {
      summary: ep.summary,
      description: ep.description,
      tags: ep.tags,
      parameters,
      responses: {
        200: {
          description: 'Successful response',
          content: { 'application/json': { example: ep.responseExample } }
        }
      }
    };

    if (ep.body) {
      op.requestBody = {
        required: true,
        content: { 'application/json': { schema: { type: 'object' } } }
      };
    }

    paths[p][method] = op;
  });

  return {
    openapi: '3.0.0',
    info: { title: 'Shopify Bridge API', version: '1.0.0', description: 'Agent-friendly bridge for Shopify catalog management.' },
    servers: [{ url: baseUrl }],
    paths,
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-Bridge-API-Key' }
      }
    },
    security: [{ ApiKeyAuth: [] }]
  };
}

function clear() {
  endpoints.length = 0;
}

module.exports = { register, getSpec, convertToOpenAPI, clear };
