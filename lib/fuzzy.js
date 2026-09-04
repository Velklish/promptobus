// Нечёткая нормализация имени. Поиск репозиториев сюда не входит — его отдаёт host.

export function normalize(name) {
  return String(name).trim().toLowerCase().replace(/[.\-_\s]+/g, '-').replace(/^-+|-+$/g, '');
}

export function tokens(name) {
  const n = normalize(name);
  return n ? n.split('-') : [];
}
