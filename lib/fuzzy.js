// Fuzzy name normalization. Repository search is not here — the host owns that.

export function normalize(name) {
  return String(name).trim().toLowerCase().replace(/[.\-_\s]+/g, '-').replace(/^-+|-+$/g, '');
}

export function tokens(name) {
  const n = normalize(name);
  return n ? n.split('-') : [];
}
