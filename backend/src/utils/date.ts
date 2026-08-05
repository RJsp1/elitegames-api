export function nowIso(): string {
  return new Date().toISOString();
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function isExpired(expiresAt: string | Date, reference = new Date()): boolean {
  const exp = typeof expiresAt === 'string' ? new Date(expiresAt) : expiresAt;
  return exp.getTime() <= reference.getTime();
}

export function secondsUntil(expiresAt: string | Date, reference = new Date()): number {
  const exp = typeof expiresAt === 'string' ? new Date(expiresAt) : expiresAt;
  return Math.max(0, Math.floor((exp.getTime() - reference.getTime()) / 1000));
}

export function parseIsoOrThrow(value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Data ISO inválida: ${value}`);
  }
  return d;
}
