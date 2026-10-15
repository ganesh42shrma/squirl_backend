// "  Date Night " → "date-night", so the same tag is always stored the same way.
function normalizeTag(tag) {
  return String(tag).trim().toLowerCase().replace(/\s+/g, '-');
}

function normalizeTags(tags = []) {
  return [...new Set(tags.map(normalizeTag).filter(Boolean))];
}

module.exports = { normalizeTag, normalizeTags };
