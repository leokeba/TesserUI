// The ROM bootloader, through esptool-js (Espressif's esptool in the
// browser): the chip's identity, then a whole-flash image written at 0x0.

import { ESPLoader, Transport } from 'esptool-js';
import { targetOf } from './firmware';

// The stub flasher's rate after the ROM's 115200: esptool's own default.
// Changing it reopens the port, which resets devkits with a USB-to-UART
// bridge (DTR and RTS move): esptool-js then goes on at 115200, about 100 s
// for a 1.8 MB image. A chip's own USB keeps the faster rate. Talking to the
// ROM at 460800 from the start fails on an ESP32 devkit.
const BAUD = 460800;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Board {
  loader: ESPLoader;
  transport: Transport;
  // "ESP32-D0WD-V3 (revision v3.1)", esp32, "c8:f0:9e:f4:a6:7c"
  description: string;
  target: string;
  mac: string;
}

// Resets the board into its bootloader and identifies it. `log` gets
// esptool's own lines, for when something fails.
export async function connect(port: SerialPort, log: (line: string) => void): Promise<Board> {
  const transport = new Transport(port);
  const terminal = { clean() {}, writeLine: log, write: log };
  const loader = new ESPLoader({ transport, baudrate: BAUD, terminal });
  try {
    const description = await loader.main();
    return { loader, transport, description, target: targetOf(loader.chip.CHIP_NAME), mac: await loader.chip.readMac(loader) };
  } catch (e) {
    await release(transport);
    throw e;
  }
}

export async function write(board: Board, image: Uint8Array, eraseAll: boolean, progress: (fraction: number) => void) {
  await board.loader.writeFlash({
    fileArray: [{ data: image, address: 0 }],
    // The image's own header says how it boots.
    flashMode: 'keep',
    flashFreq: 'keep',
    flashSize: 'keep',
    eraseAll,
    compress: true,
    reportProgress: (_, written, total) => progress(written / total),
  });
}

// Starts the new firmware, and lets go of the port: esptool's hard reset,
// EN pulled low through RTS with GPIO 0 high. esptool-js 0.7's
// after('hard_reset') only lets go of RTS, which resets nothing: devkits
// started the firmware only because closing the port moved the lines.
export async function restart(board: Board) {
  const t = board.transport;
  try {
    await t.setDTR(false);
    await t.setRTS(true);
    await sleep(100);
    // the chip's own USB may leave with the reset
    await t.setRTS(false).catch(() => {});
  } finally {
    await release(board.transport);
  }
}

export async function release(transport: Transport) {
  try {
    await transport.disconnect();
  } catch {
    // unplugged, or the chip's own USB went away with the reset
  }
}

// A chip's own USB (Espressif's vendor id: the C3's and S3's USB serial)
// leaves with the reset and comes back as another port, which this page may
// open since it has the same identity. A USB-to-UART bridge stays.
export async function settle(port: SerialPort): Promise<SerialPort> {
  const { usbVendorId, usbProductId } = port.getInfo();
  if (usbVendorId !== 0x303a) return port;
  await sleep(1000);
  for (let i = 0; i < 20; i++, await sleep(500)) {
    const ports = await navigator.serial.getPorts();
    if (ports.includes(port)) return port;
    const same = ports.find((p) => p.getInfo().usbVendorId === usbVendorId && p.getInfo().usbProductId === usbProductId);
    if (same) return same;
  }
  return port;
}
