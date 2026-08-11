const DEVICE_ID_KEY = "meologue:device-id";

/** Mints this Device's id on first run and persists it for every run after. */
export function getDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_KEY);
  if (existing !== null) {
    return existing;
  }

  const id = crypto.randomUUID();
  localStorage.setItem(DEVICE_ID_KEY, id);
  return id;
}
