// Копия нечёткой нормализации имени (BL-518, ADR-038). Поиск клонов ATI и GitLab
// в эту копию не входят — их отдаёт host.

export function normalize(name) {
  return String(name).trim().toLowerCase().replace(/[.\-_\s]+/g, '-').replace(/^-+|-+$/g, '');
}

export function tokens(name) {
  const n = normalize(name);
  return n ? n.split('-') : [];
}
