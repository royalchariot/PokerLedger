export function generateRoomCode() {
  const n = Math.floor(100000 + Math.random() * 900000);
  return String(n);
}

export function randomId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
