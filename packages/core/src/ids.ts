import { randomBytes } from "node:crypto";

/** RFC 9562 UUIDv7: time-ordered, so ids sort by creation time across peers. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export function formatKey(collectionKey: string, num: number): string {
  return `${collectionKey}-${num}`;
}

export interface ParsedKey {
  collectionKey: string;
  number: number;
}

/** Parses "MED-12" (case-insensitive) into its collection key and number. */
export function parseKey(ref: string): ParsedKey | null {
  const match = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})$/.exec(ref.trim());
  if (!match?.[1] || !match[2]) return null;
  return { collectionKey: match[1].toUpperCase(), number: Number(match[2]) };
}
