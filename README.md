# TesserUI

User interfaces for [TesserAPI](https://github.com/leokeba/TesserAPI) nodes, rendered from their **schema**. Declare your firmware's tree once in C++, and get a web UI without writing any UI code. A node that can't spare flash for HTML or JavaScript is still usable: another node, or a CDN, provides the renderer.

> **Status: early development.** The design is in [docs/DESIGN.md](docs/DESIGN.md). The web renderer, self-hosted serving, UI hosts with peer pages over ESP-NOW, stub pages, Web Serial, views, charts, forms, conditions, custom elements and embedding are implemented. The LVGL touchscreen renderer is not started yet. The API will change before 1.0.

```cpp
#include <TesserAPI.h>
#include <TesserUI.h>

tesser::Api api;
tesser::HttpServer http(api);
tesserui::WebUi web;

void setup() {
    auto& m = api.object("motor").label("Motor");
    m.value("speed", speed).range(0, 100).unit("%").step(5).ui("widget", "knob");
    m.value("invert", invert);
    m.action("stop", [] { motor.stop(); }).ui("style", "danger");
    m.object("pid").ui("advanced");

    http.enableWebSocket("/ws");
    http.begin(80, "/api");
    web.serve(http.handle());   // GET / and GET /ui.js: the whole UI, about 41 KB of flash
    api.startTask();
}
```

Open `http://<node>/`: a menu with an entry for the motor, whose page has a knob, a switch and a danger button, live through a WebSocket subscription.

## From schema to screen

Without any hint, every node gets a widget from its schema: writable booleans are switches, numbers with a range are sliders, enums are segmented controls or selects, actions are buttons (with an input when they take an argument), events are logs, lists are editable tables, objects are cards and sections in declaration order. Each top-level object is a page of its own, reached from a menu (a sidebar, a drawer on phones). Hints on the same line refine it:

| Hint | Effect |
|---|---|
| `.label("Speed")`, `.unit("%")`, `.step(5)` | Label, unit, input granularity |
| `.ui("widget", "knob")` | `toggle`, `checkbox`, `led`, `slider`, `knob`, `number`, `stepper`, `select`, `segmented`, `radio`, `text`, `password`, `textarea`, `color`, `readout`, `bar`, `gauge`, `chart`, `hold`, `button` |
| `.ui("confirm", "Move the mirror?")` | Ask before a write or a call |
| `.ui("advanced")`, `.ui("hidden")`, `.ui("readonly")` | Visibility |
| `.ui("visibleWhen", "mode=manual")`, `.ui("enabledWhen", "enabled=true")` | Conditions |
| `.ui("page")`, `.ui("card")`, `.ui("tabs")`, `.ui("inline")`, `.ui("collapsed")` | Layout |
| `.ui("icon", "sun")`, `.ui("group", "Connections")` | Menu entry icon, menu heading |
| `.ui("form")` | Edits stay local until submitted as one atomic patch |

The full vocabulary is in [DESIGN.md §5](docs/DESIGN.md#5-hints-tier-1).

## Deployments

| Mode | Who stores the bundle | How |
|---|---|---|
| Self-hosted | The node (~41 KB of flash) | `web.serve(http.handle())` |
| UI host | One ESP with spare flash, also a NowTP gateway | `nowApi.mountPeers(api.object("peers"))`: every nearby node gets a page at `#/peers/<name>`, forwarded over ESP-NOW |
| Stub | A CDN or the UI host | `web.serveStub(http.handle(), "https://cdn.jsdelivr.net/npm/tesserui@0.1.0/dist/ui.js")`: a 300-byte page |
| Launcher | GitHub Pages | Pick a node: USB (Web Serial), Bluetooth (Web Bluetooth), or its address on the network |

A NowTP-only node with no Wi-Fi needs nothing but its tree and `nowApi.advertise()`: the UI host renders it.

The launcher is at <https://leokeba.github.io/TesserUI/>. To find the nodes on your network, run the bridge next to it: `npx tesserui-bridge` (or `node bridge/bridge.mjs` from this repository). It lists the nodes that announce themselves over mDNS (`http.advertise("name", "name")`), serves them live in any browser, brings serial ports to browsers without Web Serial, and serves the launcher itself at <http://localhost:8765/>. Plug a board into USB, pair one over Bluetooth, or type a node's address: `?api=http://192.168.1.20/api` opens that node directly. A board running the USB gateway (`examples/arduino/UsbGateway` or `examples/idf/usb_gateway`) brings the NowTP nodes around it along over the one USB cable; the Bluetooth example (`examples/arduino/Bluetooth`, `examples/idf/bluetooth`) is a node a phone reaches over Bluetooth, with nothing else.

## Views

Pages that combine values from several nodes are declared on the node that serves the UI:

```cpp
tesserui::Views views(api);
auto& field = views.page("field", "Field");
field.row().widget("gauge", "/sensors/wind").widget("readout", "/sensors/sun/elevation");
field.each("/peers", "$/heliostat/status");       // one entry per mounted peer
field.card("Calibration").node("/calib");
```

## Custom widgets and pages

What the generic widgets can't show is a [custom element](docs/DESIGN.md#98-custom-elements): a standard web component, written with any framework or none. A hint puts it on any node, an object included, and a view of one element is a whole custom page:

```cpp
auto& sky = api.object("sky").ui("widget", "x-sun-dial").ui("script", "/ext/sun-dial.js");
views.page("sky", "Sky").widget("x-sun-dial", "/sky");
web.asset("/ext/sun-dial.js", kSunDial, sizeof(kSunDial) - 1, "text/javascript");   // served from flash
```

TesserUI sets the element's `value` (the node's values), `schema` and `disabled`, and gives it a `tesser` handle to write values and call actions. If it can't load, the inferred widget stands in. [examples/elements/sun-dial.js](examples/elements/sun-dial.js) is a complete one.

## Embedding and theming

The npm package mounts UIs in an application's own pages, with their own sessions and scoped styles:

```js
import { mount } from "tesserui";
mount(document.getElementById("motor"), { api: "http://heliostat.local/api", path: "/motor", routing: "memory", header: false });
```

The interface's colors (`theme`) and its own text (`strings`) are options too: `web.theme("accent", "#d97706").text("Advanced", "Avancé")` on a node.

## Examples

- [examples/arduino/SelfHosted](examples/arduino/SelfHosted): HTTP, WebSocket and the UI on one node.
- [examples/arduino/UiHost](examples/arduino/UiHost) and [examples/arduino/NowTpNode](examples/arduino/NowTpNode): a UI host and the NowTP-only nodes it renders. The host needs a larger app partition than the default (Minimal SPIFFS).
- [examples/arduino/Stub](examples/arduino/Stub): the UI loaded from a CDN.
- [examples/arduino/CustomWidget](examples/arduino/CustomWidget): a custom element served from flash, on a node and as a custom page.
- [examples/idf/self_hosted](examples/idf/self_hosted): ESP-IDF.

## Development

```sh
cd web && pnpm install && pnpm test && pnpm build    # web renderer; regenerates src/tesserui/bundle/tesserui_bundle.h
pnpm dev                                              # then http://localhost:5173/?api=http://<node-ip>/api
cmake -S . -B build && cmake --build build -j && ctest --test-dir build   # C++ (TesserAPI from ../TesserAPI or GitHub)
node web/scripts/device.mjs demo                      # the demo node on the host: http://localhost:8090/
```

## Requirements

- TesserAPI (same requirements: ESP-IDF ≥ 5.1 or Arduino-ESP32 ≥ 3.0, C++17, ArduinoJson 7)
- Evergreen browsers; Web Serial and Web Bluetooth need a Chromium-based browser

## License

MIT
