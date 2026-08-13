const TIMESTAMP_BITS = 48n;
const VERSION_BITS = 4n;
const RAND_A_BITS = 12n;
const VARIANT_BITS = 2n;
const RAND_B_BITS = 62n;

const VERSION = 0x7n; // uuidv7
const VARIANT = 0x2n; // RFC 9562 variant (10xx)

const RAND_B_SHIFT = 0n;
const VARIANT_SHIFT = RAND_B_SHIFT + RAND_B_BITS;
const RAND_A_SHIFT = VARIANT_SHIFT + VARIANT_BITS;
const VERSION_SHIFT = RAND_A_SHIFT + RAND_A_BITS;
const TIMESTAMP_SHIFT = VERSION_SHIFT + VERSION_BITS;

const RANDOM_BYTES = 10; // enough bytes to cover RAND_A_BITS + RAND_B_BITS (74 bits)

/**
 * Mints a uuidv7 (RFC 9562): a 48-bit millisecond timestamp, the version
 * and variant bits, and the rest random. Time-ordered ids cluster inserts
 * at the tail of a real index, and let a same-millisecond tie break
 * correctly on `id desc` — a higher id is the one minted later, unlike
 * uuidv4's arbitrary ordering.
 */
export function mintId(): string {
  const timestamp = BigInt(Date.now()) & ((1n << TIMESTAMP_BITS) - 1n);

  const randomBytes = new Uint8Array(RANDOM_BYTES);
  crypto.getRandomValues(randomBytes);
  let random = 0n;
  for (const byte of randomBytes) {
    random = (random << 8n) | BigInt(byte);
  }
  const randA = (random >> (BigInt(RANDOM_BYTES) * 8n - RAND_A_BITS)) & ((1n << RAND_A_BITS) - 1n);
  const randB = random & ((1n << RAND_B_BITS) - 1n);

  const uuid =
    (timestamp << TIMESTAMP_SHIFT) |
    (VERSION << VERSION_SHIFT) |
    (randA << RAND_A_SHIFT) |
    (VARIANT << VARIANT_SHIFT) |
    randB;

  const hex = uuid.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
