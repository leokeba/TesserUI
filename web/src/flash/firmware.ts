// Installing firmware from the launcher (DESIGN.md §9.7.1): what a launcher
// page configures, what its site publishes (scripts/firmware.mjs), and the
// requests that set up a TesserKIT device's Wi-Fi once it runs. Only the
// flasher (flash.js) uses the code here; ui.js imports the types alone.

import { DEFERRED_TIMEOUT_MS, errorText, type Client, type Reply } from '../client/types';
import { isObject } from '../client/json';

// One firmware the page offers: its release asset's name, with {target}
// (esp32, esp32c3...) and {version} (the tag without its "v"), as TesserKIT's
// fw.github() names them.
export interface Image {
  label: string;
  asset: string;
  description?: string;
  // How the installed firmware is reached: over its serial port (the
  // default), or over Bluetooth.
  transport?: 'serial' | 'ble';
}

// window.TESSER.firmware: the flasher's own script and the site's manifest,
// relative to the page, and the path of TesserKIT's Wi-Fi service on the
// installed device, if it has one.
export interface Firmware {
  images: Image[];
  flasher?: string;
  manifest?: string;
  wifi?: string;
}

export const FLASHER = 'flash/flash.js';
export const MANIFEST = 'firmware/manifest.json';

// What scripts/firmware.mjs writes: the latest releases, newest first, each
// asset next to the manifest under <tag>/<name>.
export interface Release {
  tag: string;
  date: string;
  assets: { name: string; size: number }[];
}
export interface Manifest {
  repo: string;
  releases: Release[];
}

export const assetName = (pattern: string, target: string, tag: string) =>
  pattern.replace(/\{target\}/g, target).replace(/\{version\}/g, tag.replace(/^v/, ''));

// The chips a release has the image for.
export function targetsOf(release: Release, image: Image): string[] {
  const esc = (s: string) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    '^' + esc(image.asset).replace(/\{target\}/g, '([a-z0-9]+)').replace(/\{version\}/g, esc(release.tag.replace(/^v/, ''))) + '$',
  );
  return release.assets.flatMap((a) => re.exec(a.name)?.[1] ?? []);
}

// The releases with an image for the firmware, for any chip.
export const releasesOf = (manifest: Manifest, image: Image) => manifest.releases.filter((r) => targetsOf(r, image).length);

// esptool-js names chips "ESP32", "ESP32-C3", "ESP32-S3": the release assets
// and ESP-IDF call them esp32, esp32c3, esp32s3.
export const targetOf = (chipName: string) => chipName.toLowerCase().replace(/[^a-z0-9]/g, '');

// --- TesserKIT's Wi-Fi service (its DESIGN.md §5.2): /sys/network/wifi ---

export interface Network {
  ssid: string;
  rssi: number;
  secure: boolean;
}

export interface WifiStatus {
  state: string;
  connected: boolean;
  ssid: string;
  ip: string;
}

const fail = (r: Reply) => new Error(errorText(r));

// The networks in range, strongest first, each name once.
export async function scan(client: Client, wifi: string): Promise<Network[]> {
  const r = await client.request({ op: 'set', path: `${wifi}/scan`, body: null }, DEFERRED_TIMEOUT_MS);
  if (r.status !== 'ok' || !Array.isArray(r.body)) throw fail(r);
  const seen = new Set<string>();
  return (r.body as unknown as Network[])
    .filter((n) => isObject(n) && typeof n.ssid === 'string' && n.ssid)
    .sort((a, b) => b.rssi - a.rssi)
    .filter((n) => !seen.has(n.ssid) && seen.add(n.ssid));
}

export async function status(client: Client, wifi: string): Promise<WifiStatus | null> {
  const r = await client.request({ op: 'get', path: `${wifi}/status` });
  if (r.status === 'not_found') return null;
  if (r.status !== 'ok' || !isObject(r.body)) throw fail(r);
  return r.body as unknown as WifiStatus;
}

// The saved networks are a keyed list (by ssid): rewriting it with the
// others' names alone keeps their passwords, which can't be read back
// (TesserAPI's keyed lists). The new network comes first.
export const savedWith = (saved: unknown, ssid: string, password: string) => [
  { ssid, password },
  ...(Array.isArray(saved) ? saved : []).flatMap((n) => (isObject(n) && typeof n.ssid === 'string' && n.ssid !== ssid ? [{ ssid: n.ssid }] : [])),
];

export async function save(client: Client, wifi: string, ssid: string, password: string) {
  const path = `${wifi}/networks`;
  const saved = await client.request({ op: 'get', path });
  if (saved.status !== 'ok') throw fail(saved);
  const r = await client.request({ op: 'set', path, body: savedWith(saved.body, ssid, password) });
  if (r.status !== 'ok') throw fail(r);
}
