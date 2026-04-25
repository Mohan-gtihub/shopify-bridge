/**
 * Flattens Shopify's paginated edges/node structure.
 * Takes either a full { edges: [...] } object or an array of edges.
 */
function flattenEdges(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data.map(edge => edge.node);
  if (data.edges) return data.edges.map(edge => flattenNode(edge.node));
  return data;
}

/**
 * Deeply flattens a Shopify node, resolving any nested edges.
 */
function flattenNode(node) {
  if (!node || typeof node !== 'object') return node;
  
  const result = { ...node };
  
  for (const key of Object.keys(result)) {
    if (result[key] && typeof result[key] === 'object' && 'edges' in result[key]) {
      result[key] = flattenEdges(result[key].edges);
    }
  }
  
  return result;
}

module.exports = { flattenEdges, flattenNode };
