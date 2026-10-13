import { describe, expect, it } from 'vitest';
import { assetName, releasesOf, save, savedWith, scan, status, targetOf, targetsOf, type Image, type Manifest } from '../src/flash/firmware';
import { FakeClient } from './fake';

// The flasher's logic (DESIGN.md §9.7.1): releases as scripts/firmware.mjs
// publishes them, and TesserKIT's Wi-Fi service (its DESIGN.md §5.2).

const full: Image = { label: 'Full', asset: 'tesserkit-full-{target}-factory.bin' };
const versioned: Image = { label: 'Lamp', asset: 'lamp-{version}-{target}.bin' };
const manifest: Manifest = {
  repo: 'leokeba/TesserKIT',
  releases: [
    { tag: 'v0.2.0', date: '2026-10-13T12:00:00Z', assets: [{ name: 'tesserkit-minimal-esp32-factory.bin', size: 1 }] },
    {
      tag: 'v0.1.12',
      date: '2026-10-12T12:00:00Z',
      assets: [
        { name: 'tesserkit-full-esp32-factory.bin', size: 1 },
        { name: 'tesserkit-full-esp32c3-factory.bin', size: 1 },
        { name: 'lamp-0.1.12-esp32s3.bin', size: 1 },
      ],
    },
  ],
};

describe('releases', () => {
  it('names an asset after the chip and the version', () => {
    expect(assetName(full.asset, 'esp32c3', 'v0.1.12')).toBe('tesserkit-full-esp32c3-factory.bin');
    expect(assetName(versioned.asset, 'esp32s3', 'v0.1.12')).toBe('lamp-0.1.12-esp32s3.bin');
  });

  it('lists the chips a release has an image for', () => {
    expect(targetsOf(manifest.releases[1], full)).toEqual(['esp32', 'esp32c3']);
    expect(targetsOf(manifest.releases[1], versioned)).toEqual(['esp32s3']);
    expect(targetsOf(manifest.releases[0], full)).toEqual([]);
  });

  it('offers only the releases with the firmware', () => {
    expect(releasesOf(manifest, full).map((r) => r.tag)).toEqual(['v0.1.12']);
  });

  it("takes esptool's chip names to ESP-IDF's targets", () => {
    expect(['ESP32', 'ESP32-C3', 'ESP32-S3', 'ESP32-P4'].map(targetOf)).toEqual(['esp32', 'esp32c3', 'esp32s3', 'esp32p4']);
  });
});

describe("TesserKIT's Wi-Fi", () => {
  const wifi = '/sys/network/wifi';

  it('scans: strongest first, each name once, hidden ones left out', async () => {
    const c = new FakeClient();
    c.answer = () => ({
      status: 'ok',
      body: [
        { ssid: 'Workshop', rssi: -70, channel: 6, secure: true },
        { ssid: '', rssi: -40, channel: 1, secure: true },
        { ssid: 'Home', rssi: -50, channel: 11, secure: true },
        { ssid: 'Workshop', rssi: -60, channel: 1, secure: true },
      ],
    });
    expect((await scan(c, wifi)).map((n) => [n.ssid, n.rssi])).toEqual([
      ['Home', -50],
      ['Workshop', -60],
    ]);
    expect(c.sent[0]).toEqual({ op: 'set', path: '/sys/network/wifi/scan', body: null });
  });

  it("saves a network first, keeping the others by name alone, so they keep their passwords", () => {
    const saved = [
      { ssid: 'Home', password: null, static: { enabled: false } },
      { ssid: 'Workshop', password: null },
    ];
    expect(savedWith(saved, 'Workshop', 'secret')).toEqual([{ ssid: 'Workshop', password: 'secret' }, { ssid: 'Home' }]);
    expect(savedWith(null, 'Home', '')).toEqual([{ ssid: 'Home', password: '' }]);
  });

  it('writes the list, and says why the device refused it', async () => {
    const c = new FakeClient();
    c.answer = (r) =>
      r.op === 'get'
        ? { status: 'ok', body: [{ ssid: 'Home', password: null }] }
        : { status: 'invalid_value', body: { error: 'invalid_value', message: 'at most 5 elements' } };
    await expect(save(c, wifi, 'Lab', 'pw')).rejects.toThrow('at most 5 elements');
    expect(c.sent[1]).toEqual({ op: 'set', path: '/sys/network/wifi/networks', body: [{ ssid: 'Lab', password: 'pw' }, { ssid: 'Home' }] });
  });

  it('a firmware without the service has no status', async () => {
    const c = new FakeClient();
    c.answer = () => ({ status: 'not_found', body: { error: 'not_found' } });
    expect(await status(c, wifi)).toBeNull();
  });
});
