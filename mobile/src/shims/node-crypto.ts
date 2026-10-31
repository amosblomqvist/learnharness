// Metro maps node:crypto here (see metro.config.js). Only server-side core
// code calls these; reaching one on the phone is a bug.
function unavailable(name: string): never {
  throw new Error(`node:crypto ${name} is not available in the mobile app`);
}

export function createHash(): never {
  return unavailable("createHash");
}

export function randomBytes(): never {
  return unavailable("randomBytes");
}
