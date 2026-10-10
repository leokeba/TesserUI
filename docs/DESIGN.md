# TesserUI design

Status: draft, being implemented. Phases 1, 2 and 4 are implemented (§14); the LVGL renderer (§10) is not started. Everything here is the specification the code follows; when the two disagree, fix one of them. Sections marked *(later)* are committed to but not part of the first release. TesserAPI references (§n of TesserAPI) point to [TesserAPI's DESIGN.md](https://github.com/leokeba/TesserAPI/blob/main/docs/DESIGN.md).

## 1. Goals

TesserUI renders user interfaces for [TesserAPI](https://github.com/leokeba/TesserAPI) nodes from their **schema**. A node declares its tree once, in C++, and gets a web UI and a touchscreen UI without any UI code. A node that can't spare flash for HTML or JavaScript is still usable: another node, or a CDN, provides the renderer.

- **Zero UI code by default.** Every TesserAPI node gets a usable interface from its schema alone: types, ranges, enums, writability, actions, events, lists and declaration order.
- **Hints on the same line.** What the schema can't say (a label, a unit, a widget choice, a confirmation) is added with TesserAPI's presentation modifiers (§7.1 of TesserAPI): `.label()`, `.unit()`, `.step()`, `.ui()`. TesserUI defines what the `ui` keys mean (§5).
- **Semantic, not visual.** A node never describes pixels. It says "a number from 0 to 255, step 5, a slider", and each renderer decides how that looks on its screen.
- **One description, several renderers:**
  - a **web** renderer: one JavaScript bundle for every node, served by a node, a UI host, a CDN or GitHub Pages
  - an **LVGL** renderer for touchscreens and small displays, driving the node it runs on or a remote one over NowTP
- **Reactive.** Values on screen follow the device through TesserAPI subscriptions; writes are immediate and reconciled with the device's read-back value.
- **Composable across nodes.** A UI host (a gateway with spare flash) mounts the NowTP nodes around it and renders any of them, plus explicit dashboard pages that combine values from several nodes (§8).

### Non-goals

- A general UI framework, pixel-level layout, or custom drawing from the device.
- An expression language. Conditions are equality tests (§5.3).
- Replacing hand-written UIs for exceptional screens. Custom pages remain possible (§7.9, *later*), but they're outside the generic renderer.
- Rendering without TesserAPI. The schema format, the request envelope and the subscription semantics are TesserAPI's.

## 2. Constraints

| Item | Decision |
|---|---|
| Device side | C++17 and TesserAPI's rules: no exceptions, no RTTI, ESP-IDF ≥ 5.1 and Arduino-ESP32 ≥ 3.0. |
| Web bundle | ≤ 50 KB gzipped for everything (JS and CSS), measured in CI. Evergreen browsers only. (Raised from 40 KB once phases 1, 2 and 4 were in: they measured 40.2 KB with every saving taken.) |
| Web stack | Svelte 5 + TypeScript + Vite, without a CSS framework or chart library. |
| LCD stack | LVGL 9.x. Display and touch drivers are the application's: TesserUI receives an `lv_display_t*`. |
| Smallest node | A NowTP-only node with no Wi-Fi and no UI assets: its tree and its hint literals are all it stores. |
| Protocol | TesserAPI as it is (phase 6): schema view, get/set/sub/unsub envelopes, forwarded subscriptions, discovered peers, `ApiClient`. TesserUI must not need private extensions; the follow-ups it would like are listed in §13. |

## 3. Architecture

```
 device firmware                     anywhere                          renderer
 ───────────────                     ────────                          ────────
 tree + hints ── TesserAPI ──▶ schema (+ui), values, sub/set ──▶ UI model ──▶ web widgets (Svelte)
                                     │                               │
                 gateway: /peers/<node>/... forwarded over NowTP     └──▶ LVGL widgets (C++)
```

1. **Schema → UI model.** A renderer fetches a node's schema and turns it into a tree of semantic widgets: the widget inference of §4, adjusted by the hints of §5. The model is the same for both renderers.
2. **UI model → screen.** The renderer lays the model out for its screen (§6) and binds each widget to a path.
3. **Data.** A store keeps the values of what is visible, fed by subscriptions, and sends writes (§7).

The two renderers share the model and its rules, not code: the web renderer is TypeScript, the LVGL renderer C++. Both are tested against the same schema fixtures (§11), so they stay consistent.

### 3.1 Deployments

| Mode | Who stores the bundle | How the browser reaches the node | Section |
|---|---|---|---|
| **Self-hosted** | The node itself (about 40–50 KB of flash) | `http://node/` | §9.4 |
| **UI host** | One ESP with spare flash, also a gateway | `http://host/#/peers/<node>`: requests forwarded over NowTP | §9.5 |
| **Stub** | A CDN or the UI host; the node serves a 300-byte page | `http://node/`, script from elsewhere | §9.6 |
| **USB** | GitHub Pages | Web Serial to the node's `LineTransport` (Chromium browsers) | §9.7 |
| **LCD, local** | n/a | `LocalClient` on the same chip | §10 |
| **LCD, remote** | n/a | `PeerClient` over NowTP, e.g. a handheld remote for a heliostat field | §10 |

## 4. Widget inference (tier 0)

Without any hint, each schema node maps to one semantic widget. The table is normative for both renderers; §10.3 gives the LVGL equivalents.

| Schema | Widget | Notes |
|---|---|---|
| `boolean`, writable | `toggle` | |
| `boolean`, read-only | `led` | On/off indicator. |
| `integer`/`number`, writable, with `min` and `max` | `slider` | With the value shown, and a numeric entry on the web. |
| `integer`/`number`, writable, no range | `number` | Numeric entry; `step` from the schema, else 1 for integers. |
| `integer`/`number`, read-only | `readout` | Formatted with `unit` and `precision`. |
| `string` with `enum`, writable | `segmented` if ≤ 4 options and each label ≤ 10 characters, else `select` | Display labels from `ui.labels` (§5.2), else the names. |
| `string`, writable | `text` | `maxLength` enforced in the input. |
| `string`, read-only (with or without `enum`) | `readout` | |
| `action`, no `arg` | `button` | |
| `action`, typed `arg` | `field` + `button` | One input of the argument's type (the rules above, with the action's `min`, `max`, `unit`), then a button. |
| `action`, `arg: "any"` | `json` + `button` | Raw JSON entry, shown only under "Advanced"; hidden on LCD. |
| `action`, `deferred` | `button`, with a busy state until the reply | Deferred actions take `tesser::Call&`, which the schema reports as `arg: "any"`: the argument isn't typed, so no JSON entry. Their reply may take up to TesserAPI's `deferTimeoutMs`: the request timeout is 15 s. |
| `action`, `returns` | as above; the result is shown next to the button | |
| `event` | `events` | The last occurrences with their payloads (web), or a toast (LCD). |
| `list` | `table` | Columns are the leaves of `items`. Rows can be edited, added (up to `maxSize`) and removed: each edit writes the whole array (TesserAPI §4.4). |
| `custom` | `json` | Read-only JSON, or a JSON editor when writable; hidden on LCD. |
| `object` | `section` | Children in declaration order (§6). |
| `remote` | `link` | The peer's name, label and online state; opens the peer's own UI (§7.6). |

- **Label:** `label` from the schema, else the node's name humanized: `brightnessMax` → "Brightness max", `pid_kp` → "Pid kp".
- **Description:** `description` is shown as help text (a tooltip on the web, hidden on small screens).
- **Units:** `unit` follows the value: "42 %", "12.5 °C".
- **Precision:** `ui.precision` decimals, else as many as `step` has, else up to 3 significant decimals for `number`.

## 5. Hints (tier 1)

Hints are TesserAPI presentation metadata (TesserAPI §7.1). `label`, `unit` and `step` are first-class schema keys. Everything else lives under `ui`, and this section defines that vocabulary.

```cpp
m.value("speed", speed).range(0, 100).label("Speed").unit("%").step(5).ui("widget", "knob");
m.action("stop", [] { motor.stop(); }).ui("style", "danger");
m.object("pid").ui("advanced");
```

**Rules:** renderers ignore keys and values they don't know, and widgets that don't fit the node's type (a `knob` on a string) fall back to tier 0. A renderer that can't draw a widget uses the nearest one it has: a `gauge` becomes a `bar`, a `knob` a `slider`. New keys are added here, never invented ad hoc in renderers.

### 5.1 `widget`: overriding the inferred widget

| Value | Applies to | Meaning |
|---|---|---|
| `toggle`, `checkbox` | boolean | Switch or checkbox. |
| `led` | boolean | Indicator, even if writable (display only). |
| `slider`, `knob` | number with range | Linear or rotary. |
| `number` | number | Numeric entry, even with a range. |
| `stepper` | number | − / value / + buttons by `step`; good for encoders. |
| `select`, `segmented`, `radio` | enum | |
| `text`, `password`, `textarea` | string | |
| `color` | string `#rrggbb` or integer `0xRRGGBB` | Color picker. |
| `readout`, `bar`, `gauge` | number | `bar` and `gauge` need `min`/`max`, which a read-only value may declare with `.range()`. |
| `chart` | number | A time series of the value, kept by the renderer (§7.7). |
| `hold` | action with a boolean `arg` | Called with `true` on press and `false` on release: jog buttons. |
| `button` | action | Explicitly a button (e.g. a typed action whose argument comes from `ui.value`). |

### 5.2 Other keys

| Key | Type | Applies to | Meaning |
|---|---|---|---|
| `labels` | string | enum | Display labels in enum order, comma-separated: `"Off,Automatic,Manual"`. |
| `precision` | number | number | Decimals shown. |
| `format` | string | readout | `"%.1f"`-style formatting, printf subset: `%d %i %u %f %.Nf %e %g %s %%`. |
| `placeholder` | string | text, number | Input placeholder. |
| `confirm` | string | action, writable value | Asks this question before the call or write. |
| `style` | string | action | `primary`, `danger` or `quiet`. |
| `icon` | string | any | A name from TesserUI's built-in icon set (§9.3); unknown names are ignored. |
| `value` | number or string | action | The argument a `button` sends: `o.action("preset", ...).ui("widget","button").ui("value", 3)`. |
| `history` | number | chart | Seconds of history (default 60). |
| `advanced` | flag | any | Shown under a collapsed "Advanced" group of its section. |
| `hidden` | flag | any | Not shown. Its value is still read and usable in conditions. |
| `readonly` | flag | value | Shown as a readout even though writable. |
| `card` | flag | object | Its own card even when nested (§6.1). |
| `page` | flag | object | Its own page or route instead of inline (§6). |
| `tabs` | flag | object | Child objects as tabs. |
| `inline` | flag | object | Children on one row (a compact group, such as x/y/z). |
| `collapsed` | flag | object | Starts collapsed. |
| `columns` | number | object | Maximum grid columns for its child cards on wide screens. |
| `form` | flag | object | Edits are local until submitted (§7.4). |
| `submit` | flag | action in a `form` | The form's submit action, when it has several. |
| `visibleWhen`, `enabledWhen` | string | any | A condition (§5.3). |
| `toast` | flag | event | Also show each occurrence as a toast (web). |

### 5.3 Conditions

`visibleWhen` and `enabledWhen` take `"<path>=<value>"` or `"<path>!=<value>"`. Several conditions joined with `&` must all hold.

- **Path:** relative to the node's parent object (`mode`, `../config/enabled`), or absolute within the node's tree (`/config/mode`).
- **Comparison:** the value at the path, as its JSON text, against the literal. `true`, `false`, `null`, numbers and enum names all compare naturally. `"mode=manual"`, `"enabled=true"`.
- **Missing values:** a condition whose path isn't in the store is false.
- **Subscriptions:** the renderer subscribes to the paths conditions use, even when those values aren't shown.

## 6. Layout

Layout follows the tree. Children render in declaration order, which is TesserAPI's child order.

### 6.1 Rules (both renderers)

1. A **page** is the root of a node, an object with `ui.page`, or a view page (§8).
2. On a page, each child **object** is a **card**. Values directly under the page's root form a first, untitled card.
3. Inside a card, values and actions are **rows**: label, then control. A nested object is a **sub-section** with a heading, and a third level is a collapsible group. `ui.card` promotes a nested object to its own card; `ui.page` makes it a link to its own page.
4. `advanced` children of a section go into one collapsed "Advanced" group at its end. On a page, an `advanced` object is a card that starts collapsed; `advanced` values go to the first card's group.
6. A card promoted with `ui.card` follows the card it comes from.
5. `remote` children render as links (§7.6), in a card of their own when their parent is the root (the `/peers` object of a UI host, for instance).

### 6.2 Web

- Cards flow in a responsive grid: one column below 640 px, then as many as fit at 360 px minimum, capped by `ui.columns` (default 3).
- Rows are a two-column grid (label, control), stacked below 300 px of card content width, so that phones (about 320 px) keep two columns.
- Phone width: no horizontal scroll, 16 px gutters, controls at least 44 px tall.

### 6.3 LCD

- The root page is a **menu**: one entry per card, plus remote links. Selecting an entry opens that card as a full-screen page. On screens ≥ 800 px wide, cards may be shown side by side like the web.
- Sub-sections are headings on the scrolling page; collapsible groups and `tabs` become sub-pages.
- A header shows the page label, a back button and the connection state.

## 7. Data and reactivity

### 7.1 Store

One store per connected node (and per peer behind a UI host):

- `schema`: the UI model, built from schema fetches (§7.2)
- `values`: a sparse JSON tree of what is visible or used by conditions
- `pending`: writes sent and not yet answered, by path
- `errors`: the last error per path, cleared by the next successful write or by navigation

Widgets bind to paths and re-render when their value changes (Svelte runes on the web; explicit setters on LVGL).

### 7.2 Schemas

- **Fetching:** `get <page path>?view=schema` with `depth` 3 for a page, deeper on demand when the user opens a sub-page or collapsible group. Over NowTP, responses are capped at 16 KB; on `too_large`, retry with `depth` 1 and fetch the children one by one (`keys`).
- **Caching (web):** in `localStorage`, keyed by origin, schema hash, path within the peer and depth. For a peer behind a UI host, the hash is the `schema` key of its stub in the parent's schema (TesserAPI §14.1). For a node reached directly, there is no hash to key on yet (§13), so its schema is fetched on every load.
- **Gateways:** a gateway's own schema contains remote stubs, whose `online` keys change its hash. Cache the schema of each remote subtree separately, under its peer's hash, and always read stubs live.

### 7.3 Subscriptions

TesserAPI allows 4 subscriptions per client (default `maxSubscriptionsPerClient`). The renderer uses at most 3:

1. **The page:** `sub <page path>` with `keys` = the visible children and `depth` = the visible depth, `interval` 100 ms. Navigating unsubscribes the old page before subscribing the new one. The snapshot fills the store. On `too_large`, subscribe with `snapshot: false` and read the visible cards with one get each.
2. **The peer's stub,** while the page is a peer's (`/peers/<name>/...`): `sub /peers` with `keys` = the peer and `depth` 1, for its online state. A page showing links needs nothing extra: unmirrored remote nodes are part of its subscription and read as `null`. A notification carrying `{"<name>": null}` means that peer changed (mounted, online state, schema hash): re-read its stub with `/peers?view=schema&depth=1&keys=<name>`.
3. **Condition paths** outside the page, when there are any.

The page subscription leaves out mirrored remote children (their copies would come along) and `ui.page` sub-pages (they subscribe themselves). Specs for the same path are merged into one subscription, since `unsub` removes every subscription of a client at a path. Beyond 3 subscriptions, or when the node answers `busy` or `not_allowed`, the rest is polled once per second; a subscribe that times out (an offline peer) is retried every 5 s.

Notifications are merge patches: apply them to `values` exactly as TesserAPI applies a `set` body. On `"overflow": true`, re-read the page with a get. Events (`op: "event"`) go to the `events` widget of their path, or to its nearest ancestor section.

### 7.4 Writes

- **Values:** the widget updates the store at once (optimistic) and marks the path pending, then sends `set <path> <value>`.
  - Sliders, knobs and color pickers send at most one write per 100 ms while dragging, and always the final value.
  - The reply is the value read back: it replaces the optimistic one and clears `pending`.
  - While a path is pending, notifications for it are held back, so the control doesn't jitter, and applied when the reply arrives.
- **Errors:** an error reply restores the last confirmed value and shows the message on the widget at the error's `path`. If that path isn't visible, on its nearest visible ancestor. `"partial": true` adds "some changes were applied".
- **Actions:** `set <path> <arg>`. `confirm` asks first. A button is disabled while its call is in flight. `returns` shows the result, and errors appear as for values.
- **Forms** (`ui.form` objects): edits stay in a local draft, shown as modified. Submit sends one patch to the object with the edited values and the submit action, either `ui.submit` or the first action: `{"az": 120, "el": 30, "go": null}`. TesserAPI validates every value before applying any and runs the action after the values (TesserAPI §6.3), so the form is atomic up to the action. Success clears the draft; errors highlight fields by `path`. Reset discards the draft.
- **Authentication:** an `unauthorized` reply opens a token prompt (web). The token is kept in `localStorage` and sent as `?token=` on the WebSocket handshake and with HTTP requests.

### 7.5 Connection state

- **Transport down:** a banner, and controls are disabled. Reconnect with backoff (0.5, 1, 2, 5 s). On reconnect, re-subscribe the current page; the snapshot refreshes the store.
- **Requests** time out after 6 s: a gateway's NowTP calls time out after 3 s, plus Wi-Fi.

### 7.6 Peers behind a UI host

- A `link` widget shows a remote node's name, its `label` (from the peer's root schema, once fetched), and its online state from its stub.
- Opening it navigates to `#/peers/<name>`. The page path is then `/peers/<name>/...`: every request goes through the gateway (forwarded gets and sets, forwarded subscriptions, TesserAPI §14).
- **Offline peers:** the page shows "offline" and disables controls. When the peer returns, the gateway's renewed subscription sends its whole state, and controls come back.
- **Mounted peers in the schema:** a stub without `online: false` is reachable.

### 7.7 Charts

A chart keeps its own history: each value received for its path (snapshot and notifications) is stored with the time it arrived, up to `ui.history` seconds. Nothing is stored on the device. A chart's path is added to the page subscription even when it is hidden behind a collapsed group, so history keeps accumulating while the page is open.

## 8. Views (tier 2)

Views are explicit pages that combine values from anywhere in a tree, including several peers. They are declared in C++ on the node that serves the UI, usually the UI host, and served as one read-only custom node, `/_ui`, so they travel over every transport like the rest of the tree.

```cpp
tesserui::Views views(api);                       // adds the custom node /_ui
auto& field = views.page("field", "Field");
field.each("/peers", "$/heliostat/status");       // one row per mounted peer
field.row().widget("gauge", "/sensors/wind").widget("readout", "/sensors/sun/elevation");
field.card("Calibration").node("/calib");         // an auto-rendered subtree
```

`GET /_ui` returns:

```json
{"pages": [
  {"id": "field", "label": "Field", "items": [
    {"each": "/peers", "item": {"node": "$/heliostat/status"}},
    {"row": [{"widget": "gauge", "path": "/sensors/wind"},
             {"widget": "readout", "path": "/sensors/sun/elevation"}]},
    {"card": "Calibration", "items": [{"node": "/calib"}]}]}]}
```

| Item | Meaning |
|---|---|
| `{"node": path, ...}` | The subtree at `path`, rendered by the tier 0 and 1 rules. Extra keys are hints that override the schema's. |
| `{"widget": w, "path": p, "label"?: s, ...}` | One widget for one path. |
| `{"row": [items]}` | Items side by side (stacked on narrow screens). |
| `{"card": label, "items": [items]}` | A card. |
| `{"text": s}` | A paragraph. Plain text; `**bold**` is the only markup. |
| `{"each": path, "item": item}` | The item repeated for each child of the object at `path`, with `$` replaced by the child's path. With `/peers`, one entry per discovered node. |

- The renderer shows view pages first, before the node's own tree, as entries of the root menu (LCD) or as tabs (web). Route: `#/v/<id>`.
- A view's subscriptions follow §7.3: one per distinct remote node involved, plus one local, within the budget of 4. When a page involves more than 3 nodes, the renderer subscribes to the nodes on screen and falls back to polling (one get per second) for the rest.
- `Views` stores its declaration as C++ structures of string literals and renders the JSON on request: no JSON document at rest. A UI host may instead serve a JSON file from its filesystem through a `custom` node with the same name and format.

## 9. Web renderer

### 9.1 Structure

```
web/
  src/client/      envelope client: WebSocket, HTTP, Web Serial transports
  src/model/       schema → UI model (§4, §5), conditions, formatting
  src/store/       values, pending writes, merge patches, subscriptions
  src/widgets/     one Svelte component per semantic widget
  src/Node.svelte  recursive renderer: dispatches on the model node's widget
  src/App.svelte   routing, connection state, the device list
  test/            vitest: model and store against schema fixtures
```

### 9.2 Client

- **WebSocket** (default): `ws://<host><wsPath>`, one envelope per text frame (TesserAPI §10.1). Numeric ids, a 6 s timeout per request. Notifications are routed by path to the store.
- **HTTP fallback** when the WebSocket can't connect (a node without `enableWebSocket()`):
  - reads with `GET <api>/<path>?view=&depth=&keys=`
  - writes with `PUT`
  - no subscriptions: the visible page is polled once per second
- **Web Serial** (§9.7): newline-delimited envelopes. Lines that don't start with `{"` are ignored, and parsing starts at the first `{"` of a line, since ESP log output can interleave. A bare `\n` is sent after opening, because opening the port resets most devkits.
- **Configuration:** `window.TESSER = {api: "/api", ws: "/ws", minVersion: "x.y.z"}` in the page (`ws: null`: HTTP only), or the defaults `/api` and `/ws` on the page's origin. For development, the query string overrides it: `?api=http://<ip>/api` (the WebSocket defaults to `/ws` on the same host), `?ws=` (empty: HTTP only), `?transport=serial`.
- **Fallback:** if the WebSocket never opens, the client switches to HTTP for good. Once it has opened, it reconnects with backoff (§7.5).
- **Numbers:** integers beyond 2^53 (TesserAPI serves 64-bit values) are parsed as `BigInt` and written back exactly (`JSON.rawJSON`).

### 9.3 Look

- CSS variables for colors, spacing and radius, with light and dark themes following `prefers-color-scheme`. One system font stack, no web fonts.
- Icons: an inline SVG sprite of about 30 icons, within the bundle budget.
- Native inputs wherever they exist (`input type=range`, `checkbox role=switch`, `select`), for keyboard and screen-reader support at no cost.
- Charts: a small canvas line chart written for TesserUI.

### 9.4 Self-hosted

The build produces `ui.js` (one IIFE script, CSS injected), `ui.js.gz` and `index.html` (for a CDN or Pages). It also produces `tesserui_bundle.h` with the gzipped script as a byte array, its version, and its FNV-1a hash for the ETag. The gzip is made with zopfli, about 4 % smaller than `gzip -9`, and that is what the budget measures.

A node doesn't store `index.html`: `WebUi` generates the page at `/` (about 300 bytes) with the configuration of §9.2 in `window.TESSER` (API and WebSocket paths, `minVersion`).

```cpp
tesser::HttpServer http(api);
http.begin(80, "/api");
http.enableWebSocket("/ws");
tesserui::WebUi web;
web.serve(http.handle());              // GET / and GET /ui.js on the same server
```

- **Headers:** `ui.js` has `Content-Encoding: gzip`, `ETag`, and `Cache-Control: no-cache`, so a browser revalidates with `If-None-Match` and gets a 304. The page has `Cache-Control: no-cache`.
- **API base path:** must not be empty: TesserAPI's wildcard would shadow `/`.
- **Handlers:** two URI handlers. `HttpServer::begin()` registers 10, of which TesserAPI uses at most 6.
- **Flash:** the bundle and about 2 KB of code.

### 9.5 UI host

A node with spare flash serves the bundle (§9.4), runs a NowTP gateway, and mounts its peers:

```cpp
radio.onPeerEvent([](nowtp::PeerEvent e, const nowtp::PeerInfo& p) { nowApi.peerEvent(e, p); });
nowApi.mountPeers(api.object("peers").label("Nodes"));
```

The web app shows the host's own tree and the `/peers` card of links. Every other node only needs `nowApi.advertise()` and its tree.

**Wi-Fi channel:** a host in station mode puts ESP-NOW on the router's channel, so every node must use it. A field without a router runs the host as a soft AP; the NowTP nodes then use its channel.

### 9.6 Stub

A Wi-Fi node without the bundle serves a page that loads `ui.js` from elsewhere:

```cpp
web.serveStub(http.handle(), "https://cdn.jsdelivr.net/npm/tesserui@1.0.0/dist/ui.js");
// or from a UI host on the network: "http://192.168.1.10/ui.js"
```

- **Same origin:** the page's origin is the node, so API and WebSocket requests are same-origin. There's no CORS setup, and no mixed content: an HTTP page may load an HTTPS script.
- **Offline fallback:** if the script doesn't load (no internet), the stub shows a one-line explanation and links to the raw API.
- **Pinning:** the CDN URL pins an exact version, so the bundle stays compatible with the node's TesserUI version.

### 9.7 USB (Web Serial)

The same bundle, published on GitHub Pages, connects to a node over USB with Web Serial (Chromium-based browsers only; Pages provides the secure context it needs). It works for a node with no radio at all, and serves as the debugging tool. An HTTPS page can't talk to `http://` or `ws://` devices (mixed content), so on Pages, Web Serial is the only transport offered.

## 10. LVGL renderer

### 10.1 API

```cpp
tesser::LocalClient client(api);               // or PeerClient(nowApi.endpoint(), mac)
tesserui::LvglUi ui(client, display);          // display: an lv_display_t* the application set up
ui.begin("/");                                 // root path; view pages too if /_ui exists

void lvglTask() {
    for (;;) {
        ui.loop();                             // client.process(), then UI updates
        lv_timer_handler();
        vTaskDelay(pdMS_TO_TICKS(5));
    }
}
```

- **Threading:** all LVGL calls and all `ApiClient` callbacks run in the task that calls `ui.loop()`. That is what `ApiClient::process()` guarantees (TesserAPI §14.2), so no locks are needed.
- **Input:** pointer (touch) devices work directly. For encoders and keypads, each page's focusable widgets go into one `lv_group_t`, which the application attaches to its input device with `ui.group()`.

### 10.2 Memory

- **One page at a time.** Entering a page fetches its schema, builds a compact descriptor per widget (type, path, label, unit, range, hints), and frees the JSON document. Leaving a page deletes its LVGL objects and descriptors. Memory scales with the page, not the tree.
- **Strings** of a page live in one arena freed with the page.
- **Targets** (classic ESP32, no PSRAM, 320×240 RGB565):
  - per page of 20 widgets: ≤ 16 KB of RAM besides LVGL's own objects
  - partial draw buffers of 1/10 screen: 15 KB
  - measured and enforced like TesserAPI's figures

### 10.3 Widget mapping

| Semantic widget | LVGL |
|---|---|
| `toggle`, `checkbox` | `lv_switch`, `lv_checkbox` |
| `led` | `lv_led` |
| `slider` | `lv_slider` + value label |
| `knob` | `lv_arc` + value label |
| `number`, `stepper` | `lv_spinbox` with − / + buttons |
| `select`, `radio` | `lv_dropdown` |
| `segmented` | `lv_buttonmatrix` (one checked) |
| `text`, `password`, `textarea` | `lv_textarea` + one shared `lv_keyboard` |
| `readout` | `lv_label` |
| `bar` | `lv_bar` |
| `gauge` | `lv_scale` with a needle |
| `chart` | `lv_chart` |
| `button`, `hold` | `lv_button` (`hold`: `LV_EVENT_PRESSED` / `LV_EVENT_RELEASED`) |
| `events` | a toast: a label that fades out after 3 s |
| `table` | `lv_list` of rows; a row opens its element as a page |
| `link` | a menu entry with an online dot |
| `confirm` | `lv_msgbox` |
| `json`, `color` | not rendered *(color later)* |

- **Units:** LVGL's built-in Montserrat fonts cover ASCII and `°`. Other units (`µ`, `Ω`) need the application to provide a font, set with `ui.font()`.
- **Monochrome displays** (SSD1306 128×64 with buttons or an encoder) *(later)*: a compact profile with one row per line, no cards, and value editing on a focus-and-edit screen.

## 11. Testing

1. **Schema fixtures:** JSON schemas and value trees captured from real firmware: TesserAPI's test firmware, the demo, and the ported helionext motors page. They are shared by both renderers' tests.
2. **Model tests** (vitest): inference (§4), hints (§5), conditions, formatting and layout decisions produce the expected UI model for each fixture.
3. **Store tests** (vitest): merge patches, pending writes and their reconciliation, overflow, reconnect and forms, against a fake client.
4. **Web end-to-end** (Playwright): the bundle against the TesserAPI test firmware on hardware, self-hosted and through a UI host. Each widget type gets a scripted interaction, checked against the device's read-back value. The suite also measures the bundle size, a first render under 1 s on a mid-range phone, and the write round trip.
5. **Host node:** `test/` builds `tesserui_demo`, the demo tree on real TesserAPI over `LineTransport`s on stdin/stdout, with live values, events, a deferred action, and peers behind an in-memory link through TesserAPI's real forwarding. `web/scripts/device.mjs` serves it as a self-hosted node does (page, bundle, HTTP, WebSocket), shared by every client, or with one fresh node per connection for the end-to-end tests (Playwright, `web/e2e`).
6. **LVGL:** the renderer is built for the host with LVGL's SDL driver and screenshot-tested against the fixtures. On-target tests then check memory per page and that no heap is lost across page changes.
7. **CI:** web tests, bundle-size budget, LVGL host build and screenshots, plus ESP-IDF and Arduino builds of the examples, as in TesserAPI.

## 12. Packaging

```
TesserUI/
  docs/DESIGN.md
  web/                 the web renderer (npm package "tesserui": dist/ui.js, index.html)
  src/tesserui/        C++: WebUi (bundle and stub serving), Views, LvglUi
  src/tesserui/bundle/ tesserui_bundle.h, generated by the web build and committed per release
  examples/            self-hosted, UI host + NowTP node, stub, LCD local, LCD remote
  CMakeLists.txt, idf_component.yml, library.json, library.properties
```

- **C++ library:** depends on TesserAPI. `LvglUi` is compiled only when LVGL is in the build (`__has_include(<lvgl.h>)` on Arduino and PlatformIO; component detection on ESP-IDF, as TesserAPI does for NowTP). `WebUi` is compiled only on ESP with `esp_http_server`.
- **Versions:** the npm package and the C++ library share version numbers. The bundle reports its version, and a node may require a minimum one with `web.minVersion()`: a bundle older than that shows a warning banner.

## 13. Follow-ups wanted in TesserAPI

None blocks the first release; each has a workaround above.

| Item | Why | Workaround until then |
|---|---|---|
| Expose `schemaHash()` over the API (for instance `view=hash`) | Cache the schema of nodes reached directly (§7.2). | Fetch the schema on every load. |
| Re-advertise automatically when the tree changes (`mountPeers` mounts change a gateway's schema) | The advertised hash goes stale on gateways, and stale caches would show the wrong schema. | Gateways call `advertise()` again after mounting; renderers don't cache gateways' own schemas (§7.2). |
| Typed object arguments for actions (`describe(Target)` → `arg` is an object schema) | Forms for multi-field actions without a wrapper object. | The `form` hint on an object of values plus an action. |
| Coalescing per forwarded subscriber (`interval` is the first subscriber's) | Slow clients behind a UI host. | Pages ask for 100 ms everywhere. |
| A BLE transport | Web Bluetooth, phones without Wi-Fi access to the node. | USB or a UI host. |
| Deferred actions without an argument shouldn't report `arg: "any"` | Tell a deferred action that takes an argument from one that doesn't. | Deferred actions are buttons (§4). |

## 14. Roadmap

| Phase | Content | Acceptance | Status |
|---|---|---|---|
| 1 | UI model (§4, §5), web client and store, widgets for every tier 0 type, self-hosted serving | The TesserAPI test firmware is fully usable from a phone; bundle within the budget of §2. | implemented; checked on hardware: the test firmware driven from a browser (WebSocket and HTTP), and `WebUi` serving the bundle from a chip's flash (ETag, 304). Token authentication works over WebSocket and HTTP. |
| 2 | UI host: `/peers` links, peer pages through the gateway, offline handling, stub serving, Web Serial | A NowTP-only node is controlled from a browser through a UI host, with live values. | implemented; peer pages and forwarded subscriptions checked through the test firmware's gateway over ESP-NOW. Built but not yet run on hardware: the UI host and NowTP-only node examples, stub serving (host-tested), Web Serial. |
| 3 | LVGL renderer: pages, widget mapping, `LocalClient` and `PeerClient` | The same node on a 320×240 touchscreen, locally and from a remote handheld. | not started |
| 4 | Views (§8), charts, forms, conditions | helionext's motors and calibration pages, ported with no hand-written UI: `describe()` plus hints. | implemented; the motors fixture renders without UI code, and views, charts, forms and conditions pass end-to-end tests against the host demo device |
| 5 | Monochrome profile, color widget, custom pages *(later)* | | color widget done (web) |

## 15. Decisions

- **Hints live in TesserAPI's schema, not in a separate UI file.** One declaration per field, and they reach every renderer through every transport. TesserAPI only stores them (§7.1 of TesserAPI), so it stays UI-agnostic.
- **Renderers don't share code.** A shared C core compiled to WebAssembly would cost more bundle than the TypeScript it replaces. Consistency comes from the shared fixtures (§11).
- **Svelte rather than Preact or Lit:** compiled output, signals-based reactivity, and the stack `small-webui` and helionext already use. The deciding rule is the bundle budget (§2). If the budget is at risk, reconsider.
- **No device-side history for charts.** A renderer keeps history while it watches. Devices that need logged history expose it as a list or a custom node.
