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
- Replacing hand-written UIs for exceptional screens. Those are custom elements (§9.8), which the generic renderer hosts: a widget for one node, or a whole page.
- Rendering without TesserAPI. The schema format, the request envelope and the subscription semantics are TesserAPI's.

## 2. Constraints

| Item | Decision |
|---|---|
| Device side | C++17 and TesserAPI's rules: no exceptions, no RTTI, ESP-IDF ≥ 5.1 and Arduino-ESP32 ≥ 3.0. |
| Web bundle | ≤ 65 KB gzipped for everything (JS and CSS), measured in CI. Evergreen browsers only. (Raised from 40 KB once phases 1, 2 and 4 were in: they measured 40.2 KB with every saving taken. Raised from 50 KB for the navigation menu, §6.3, from 52 KB for the launcher and Bluetooth, §9.7, from 54 KB for notifications, §7.8, from 55.5 KB for file nodes in list elements, §4, from 56.5 KB for events over HTTP, §9.2, from 57 KB for files over serial and Bluetooth, §4, from 57.5 KB for the log widget, §4, from 58 KB for installing firmware from the launcher, §9.7.1 (its flasher is a script of its own, outside the budget), from 58.5 KB for moving rows and choosing a node, §5.2, from 59 KB for nodes as tabs, §6.5, from 59.5 KB for applying a change to every node, §6.6, and from 60 KB for checking a node's identity on every reconnection, §7.5, and easing the load on a node under stress, §7.3. 65 KB is the ceiling: beyond it, what only a launcher uses is a script of its own, as the flasher and the launcher's workspace are, §9.7.2.) |
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
| **Launcher** | GitHub Pages | The user picks the node: USB (Web Serial), Bluetooth (Web Bluetooth), or an address on the network; or installs firmware on a board (§9.7.1) | §9.7 |
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
| `string` with `ui.options`, writable | `select` | The current keys of the keyed list `ui.options` names, or the children of the object it names (the nodes under `/peers`, an offline one marked), after the fixed choices of `ui.optionsExtra` (§5.2). Updated as the list changes. |
| `string`, writable | `text` | `maxLength` enforced in the input. |
| `string`, writable, `secret` | `password` | Whatever `ui.widget` says. The value always reads as `null` (TesserAPI §4.1): the field starts empty with a `••••••••` placeholder, and only what the user types is sent. |
| `string`, read-only (with or without `enum`) | `readout` | |
| `action`, no `arg` | `button` | |
| `action`, typed `arg` | `field` + `button` | One input of the argument's type (the rules above, with the action's `min`, `max`, `unit`), then a button. |
| `action`, `arg: "object"` | `button` with its `params` as fields | One input per value of the argument's object (nested objects flattened), each inferred by the rules above, then the button with the action's label. Untouched fields are left out of the argument, so the device uses its defaults. |
| `action`, `arg: "any"` | `json` + `button` | Raw JSON entry, shown only under "Advanced"; hidden on LCD. |
| `action`, `deferred` | as above, with a busy state until the reply | A deferred action taking `tesser::Call&` alone reports `arg: "any"`: it is a plain button, no JSON entry. Typed deferred actions (`(T, Call&)`) get their input. Their reply may take up to TesserAPI's `deferTimeoutMs`: the request timeout is 15 s. |
| `action`, `returns` | as above; the result is shown next to the button | Any reply other than `null` is shown, since a deferred action's reply has no declared type. |
| `event` | `events` | The last 8 occurrences (`ui.lines`), newest first, each with its time and payload (web), or a toast (LCD). |
| `list` of at most 3 short fields, without actions or files | `table` | Fields are short when they are top-level values drawn as `text`, `password`, `number`, `slider`, `select`, `segmented`, `toggle`, `readout` or `led`, without conditions. Columns are the leaves of `items`. Rows can be edited, added (up to `maxSize`) and removed: each edit writes the whole array (TesserAPI §4.4), without its read-only fields, which the device would refuse, and the `secret` fields it couldn't read. Each item patches its element, keeping the fields it leaves out; a keyed list (`key`) is matched by key, not index, so those survive removals and reordering; its rows are named by their key column instead of an index. |
| any other `list` | `list` | One line per element: its name (the key, else its first value), up to three short values (flags by their labels), its first writable boolean as a switch, a download and an upload button for each of its file nodes (below), and a remove button. A boolean field with `ui.icon` marks the line with that icon while true (a folder in a file browser). A line opens into the element's own controls, built like a section at the element's path (`/sys/timers/morning`), so every widget, nested object and condition works, and each control writes its own path; a keyed list's paths go through it by key, each name percent-encoded in URLs (`/api/sys/files/entries/my%20notes.txt/content`). Adding to a keyed list asks for the new element's key first, and sends only the keys, which keeps the other elements whole (TesserAPI §4.4). `ui.widget` `table` or `list` chooses. |
| `list` without `writable` | `table` or `list`, read-only | A list the device fills (TesserAPI's `ListNode::readOnly()`: scan results, peers nearby): no add or remove buttons, and its elements' values come without `writable`, so they are readouts. Actions and file nodes in its elements still work. Lists have said `writable` since TesserAPI a2b0002; older firmware's lists read as read-only (no fallback, before 1.0). |
| `array` | `table` | One column of `items`' type. Read-only arrays aren't editable, and fixed-length ones (`fixed`) have no add and remove. With `ui.widget: "chart"`, a numeric array is plotted by index instead (a calibration table). With `ui.reorder`, rows move up and down. |
| `file` | `file` | A download button when `readable`, a file input and an upload button when `writable`, with a progress bar. Files go over HTTP (`GET`, and `PUT` with the raw file as body) wherever the node has it, WebSocket sessions included: raw bytes are faster. A client with no HTTP (serial, Bluetooth, a serial port through the bridge) moves them in TesserAPI's `upload` and `download` envelopes (TesserAPI §10.1.1), in base64 chunks, and so does a WebSocket session for a file below a remote node: a gateway relays both (TesserAPI §14), but one relaying over HTTP serves nothing else until the transfer ends, its WebSocket included (about 30 s for a 1 MB image), where envelopes keep it live, at about two thirds of the speed. a download follows `offset` until `end`, with its name and type from the opening reply; an upload opens with its `size` and `filename`, learns the device's `chunk`, then sends from `received`, and the reply of the chunk that completes it is the upload's. A chunk whose reply doesn't come within 10 s is sent again at the same offset, up to four times, which the device makes harmless; 10 s outlasts a gateway's own retries of a relayed chunk (three of its 3 s timeout), after which it answers `timeout`. A `busy` chunk (a gateway still relaying the try given up on, or at its `maxPending`) is sent again a second later, within the same four tries. An upload's opening and its last chunk aren't: an opening restarts the upload, and the last reply can't be asked again; they wait 15 s, for handlers that take long (erasing a firmware partition, checking the image). Serial at 115200 baud moves about 8 KB/s each way, so a 1 MB firmware takes two minutes. An upload names the chosen file in a `filename` query parameter (`PUT /api/sys/files/upload?filename=notes.txt`, TesserAPI's `FileRequest::filename`). In a list's element, the file node's path goes through the element (by key for a keyed list), and its line has icon buttons: choosing a file there uploads it at once, and the outcome is a toast; its conditions are the element's (`visibleWhen: "isDir=false"`). `maxSize` is checked before sending, `ui.confirm` asked first. The download's name is the device's (`Content-Disposition`), else `ui.filename`, else the node's name with an extension from `contentType`; the schema's `accept` (TesserAPI's `.accept()`), else `ui.accept`, filters the file chooser. Files have no value: pages don't read or subscribe to them. |
| `custom` | `json` | Read-only JSON, or a JSON editor when writable; hidden on LCD. |
| `object` | `section` | Children in declaration order (§6). |
| `remote` | `link` | The peer's name, label and online state; opens the peer's own UI (§7.6). |

- **Label:** `label` from the schema, else the node's name humanized: `brightnessMax` → "Brightness max", `pid_kp` → "Pid kp".
- **Description:** `description` is shown as help text (a tooltip on the web, hidden on small screens).
- **Units:** `unit` follows the value: "42 %", "12.5 °C". Integers in `B` and `s` are scaled: "178.4 KB", "1.94 MB", "6 min 39 s", "2 d 3 h".
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
| `slider`, `knob` | number with range | Linear or rotary. A range spanning 0 has a detent there: dragging within 2.5 % of the range from 0 gives exactly 0. Keys and typed values aren't snapped. |
| `number` | number | Numeric entry, even with a range. |
| `stepper` | number | − / value / + buttons by `step`; good for encoders. |
| `select`, `segmented`, `radio` | enum | |
| `text`, `password`, `textarea` | string | |
| `color` | string `#rrggbb` or integer `0xRRGGBB` | Color picker. |
| `flags` | integer | One checkbox per bit, labelled by `ui.labels`, bit 0 first: `.ui("widget", "flags").ui("labels", "Mon,Tue,Wed,Thu,Fri,Sat,Sun")`. |
| `timezone` | string | The IANA time zones the browser knows; choosing one writes its POSIX TZ string (`<+01>-1<+02>,M3.5.0,M10.5.0/3`), derived from the zone's offsets over the current year, which is what `tzset()` reads on the device. |
| `readout`, `bar`, `gauge` | number | `bar` and `gauge` need `min`/`max`, which a read-only value may declare with `.range()`. |
| `chart` | number, numeric array | A time series of the value, kept by the renderer (§7.7); for an array, its values by index. |
| `log` | event | Payloads as lines of a log, such as ESP-IDF's (TesserKIT's `/sys/log/line`): a string as it is, any other payload as JSON, in monospace, one line each without wrapping and without a time (the device's line has its own). The last `ui.lines` (default 100), oldest at the top, in a box of fixed height that scrolls; it stays at the end as lines arrive unless the user scrolled up. Lines too long for the box scroll sideways within it. A line starting with ESP-IDF's `E (` is red, `W (` amber. A button in the box's top right corner clears it, on this screen only. On LCD, an `events` widget. |
| `hold` | action with a boolean `arg` | Called with `true` on press, again every `ui.keepalive` ms while held (default 300), and `false` on release: jog buttons behind a dead-man timer (§7.4). |
| `button` | action | Explicitly a button (e.g. a typed action whose argument comes from `ui.value`). |
| any name with a hyphen (`x-sun-dial`) | any node, objects included | A custom element (§9.8), web only. Other renderers use the tier 0 widget; on an object, its section. |

### 5.2 Other keys

| Key | Type | Applies to | Meaning |
|---|---|---|---|
| `labels` | string | enum, flags | Display labels in enum order, comma-separated: `"Off,Automatic,Manual"`; for `flags`, one per bit. |
| `group` | string | top-level object | The menu heading it's listed under (§6.3): `"Connections"`. |
| `options` | string | writable string, string action argument | The path of a keyed list (TesserAPI §4.4), relative or absolute as a condition's (§5.3): the value is one of its keys; or of an object: the value is one of its children's names, labelled from a remote node's own schema when it was read, `(offline)` after an offline one (a node to choose among those under `/peers`), chosen in a `select` (`radio` and `segmented` fit too). The renderer subscribes to the list even when it isn't shown. The device still validates the value. A list whose rows hold such a field opens element by element instead of being a table. |
| `optionsExtra` | string | with `options` | Fixed choices listed before the keys, comma-separated: `"Sun"`. |
| `optionsValue` | string | with `options` naming an object | The field of each child's schema the value is, instead of the child's name: `id`, a remote node's device id (its MAC, TesserAPI §14.1), which stays when names change or collide. A child without the field isn't a choice. A stored value no child has shows as itself, `(not found)`. |
| `reorder` | flag | writable array, writable keyed list | Rows move up and down, for an order that means something (priorities). Each move writes the whole array. An indexed list doesn't move: its rows' unwritten fields (read-only, secret) would stay behind at their index. |
| `filename`, `accept` | string | file | The download's file name; the upload's file chooser filter (`".bin"`). |
| `precision` | number | number | Decimals shown. |
| `format` | string | readout | `"%.1f"`-style formatting, printf subset: `%d %i %u %f %.Nf %e %g %s %%`. |
| `placeholder` | string | text, number | Input placeholder. |
| `confirm` | string | action, writable value | Asks this question before the call or write. |
| `style` | string | action, read-only value | Actions: `primary`, `danger` or `quiet`. A read-only value: `warning` shows it as a warning callout, its label and value on a tinted background, usually with `visibleWhen` (TesserKIT's "no admin account" notice). |
| `icon` | string | any | A name from TesserUI's built-in icon set (§9.3); unknown names are ignored. On a boolean field of a list element, it also marks the element's line while true (§4). |
| `value` | number or string | action | The argument the action's button sends, instead of an input: `o.action("preset", ...).ui("value", 3)`. `"$now"` sends the browser's clock (milliseconds since 1970). |
| `auth` | string | action | `"login"`: the action signing clients in (§7.4). `"whoami"`: the action telling a client its access level. |
| `history` | number | chart | Seconds of history (default 60). |
| `lines` | number | event | How many occurrences the renderer keeps: default 8 for `events`, 100 for `log`. |
| `keepalive` | number | writable number or boolean, `hold` action | Milliseconds between keep-alives for a device's dead-man timer (§7.4). A `hold` action repeats every 300 ms without it. |
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
| `toast` | flag or string | event | Also show each occurrence as a toast (§7.8), whatever page is on screen: `true` is `"info"`; or `"ok"`, `"warn"`, `"error"`. With `hidden`, a toast only, without an events log. |
| `script` | string | custom element | URL of the module script defining the element (§9.8), relative to the node's API. |

### 5.3 Conditions

`visibleWhen` and `enabledWhen` take `"<path>=<value>"` or `"<path>!=<value>"`. Several conditions joined with `&` must all hold.

- **Path:** relative to the node's parent object (`mode`, `../config/enabled`), or absolute within the node's tree (`/config/mode`).
- **Comparison:** the value at the path, as its JSON text, against the literal. `true`, `false`, `null`, numbers and enum names all compare naturally. `"mode=manual"`, `"enabled=true"`.
- **Missing values:** a condition whose path isn't in the store is false.
- **Subscriptions:** the renderer subscribes to the paths conditions use, even when those values aren't shown.

## 6. Layout

Layout follows the tree. Children render in declaration order, which is TesserAPI's child order.

### 6.1 Rules (both renderers)

1. A **page** is the root of a node, a menu entry (§6.3), an object with `ui.page`, or a view page (§8). An object that is a form, tabs or an inline group stays one card on its own page.
2. On a page, each child **object** is a **card**, and so is each list (titled by it). Actions without an argument directly under the page are buttons beside its title. Other values directly under the page's root form a first, untitled card; when only `advanced` ones are left, they form a collapsed card titled "Advanced", last.
3. Inside a card, values and actions are **rows**: label, then control. A nested object is a **sub-section** with a heading, and a third level is a collapsible group, open unless `ui.collapsed`; one whose schema the page's depth cut is fetched when open. `ui.card` promotes a nested object to its own card; `ui.page` makes it a link to its own page.
4. `advanced` children of a section go into one collapsed "Advanced" group at its end, unless nothing else in it is shown (to this client): then they are shown as they are. On a page, an `advanced` object is a card that starts collapsed; `advanced` values go to the first card's group.
6. A card promoted with `ui.card` follows the card it comes from.
5. `remote` children render as links (§7.6), in a card of their own when their parent is the root (the `/peers` object of a UI host, for instance).

### 6.2 Web

- **Columns:** one below 640 px of page width, then as many as fit at 360 px minimum, capped by `ui.columns` (default 3).
- **Placement:** each card, in order, goes to the column whose cards weigh least so far, so reading order stays roughly row by row and columns end level. Placement comes from the model, not from measured heights: cards move only when the number of columns changes, never when a group opens or a value grows.
- **Weight:** a card's rows, roughly. A value or an action is 1; a chart, an events log 3; a log 6; a table or a list 4; a gauge, a knob, a text area 2; a custom element 8; a link 1.5; a heading or a title 1. A collapsed card or group is 1, an "Advanced" group 1, tabs their heaviest tab, hidden items 0. The gap between cards counts 1.
- Rows are a two-column grid (label, control), stacked below 300 px of card content width, so that phones (about 320 px) keep two columns.
- Phone width: no horizontal scroll, 16 px gutters, controls at least 44 px tall.

### 6.3 Menu (both renderers)

A node's UI is a **menu** of pages rather than one page of every card.

- **Entries,** in order:
  - the view pages (§8);
  - **Status**: the start page's own values, lists and actions (`#/`), when it has any;
  - one entry per child object and remote node of the start page, in tree order (`#/heliostat`). Hidden objects have none.
- **Labels and icons** come from `label` and `ui.icon`; a view's from its page (`views.page("overview", "Overview").icon("eye")`).
- **Groups:** top-level objects with the same `ui.group` (`"Controllers"`, `"Connections"`) are gathered under that heading, where the first of them would be.
- **Sub-entries:** an object with `ui.page` (`/sys`), or one holding remote nodes (`/peers`), lists its objects, lists and nodes as sub-entries, one level deep. A list's page is the list alone. The web shows them while the entry's page, or one of theirs, is open.
- **Pages:** an entry's page follows §6.1 with the object as its root: its own values form the first card, and its child objects are cards. The start page shows its own values only, the rest being entries. A remote node's entry opens its root page (§7.6).
- **Start:** the first entry opens when the route is empty, when it names a view that doesn't exist (renamed by a firmware update), or when it is the start page and that has no entry of its own.
- **Web:** a sidebar beside the page; below 800 px, a drawer opened from the header's menu button, closed by choosing an entry. The header keeps the device label (or the node tabs, §6.5), the connection state and sign-in. The menu replaces the view tabs. It's on for the node's own page and off when the UI is embedded or has no header (§9.9): those show the start page with every card, and view tabs. The `menu` option (§9.2) decides otherwise.

### 6.4 LCD

- The menu (§6.3) is the root screen. Selecting an entry opens its page full-screen. On screens ≥ 800 px wide, cards may be shown side by side like the web.
- Sub-sections are headings on the scrolling page; collapsible groups and `tabs` become sub-pages.
- A header shows the page label, a back button and the connection state.

### 6.5 Nodes as tabs (web)

A gateway's UI reaches other nodes: the remote nodes of its tree (TesserKIT's `/peers`, mounted over NowTP and UDP, TesserAPI §14.1). With the menu on, they are tabs in the header, so the user moves between whole UIs without leaving the page.

- **Tabs:** the node itself first, then each remote node of its own tree, in tree order. Remote nodes inside another remote node aren't tabs: a peer's peers are in its own menu.
- **A tab's label** is the stub's label, else the label of the peer's root (read at depth 0, and cached under its advertised hash), else its name. An offline node has a dot, and the tooltip gives its `id` and `route`.
- **A tab is a node's whole UI:**
  - its menu (§6.3), built from the remote node's root;
  - its pages;
  - its views (§8), read from its `/_ui` through the gateway, their paths moved below the node.
- **Routes** stay the node's paths (`#/peers/<name>/...`; a remote node's view is `#<node>/_ui/<id>`). The tab follows from the route, so links, the back button and shared URLs keep working.
- **Opening a tab** opens its node's root: its status, or its first entry when it has none (§6.3, *Start*). The menu waits for the node's views, which come first.
- **On or off:** tabs are on by default with the menu, when the node has remote nodes. A header button switches them off and back, and the browser remembers it; `tabs: false` (§9.2) makes off the default. Off, remote nodes are entries of the device's menu (§6.3), and a peer's root page shows all its cards.

### 6.6 Apply to all (web)

Setting up many nodes alike (a field of heliostats, the lamps of a show) means making one change on each. **Apply to all** makes it once: while it is on, each write the user makes on the node shown goes to every other tab's node (§6.5) at the same path below its root.

- **What goes:** every write the user makes: values, including each write of a drag; action calls, including a hold's repeats; keep-alive re-sends, so every node's dead-man timer is fed; a form's patch. Sign-in, files and subscriptions stay on their node.
- **How:** one set per node, all at once. A gateway takes them up to its pending slots (TesserAPI's `maxPending`) and answers `busy` beyond, so they wait and are sent again, as schema reads are (§7.2). The UI doesn't use a `*` fan-out (TesserAPI §6.5): each match would take a pending slot too, and a `*` can't leave out the node being edited when it is itself a peer.
- **Nothing is checked first.** Each node's reply tells:

  | Reply | The node's tab shows |
  |---|---|
  | `ok` | done (✓) |
  | `not_found` | absent (–): the node doesn't have that path |
  | any other error | refused (✕), the node's message in its tooltip |
  | (an offline stub: not sent) | offline: its dot |

- **When some node is offline or refused,** one `warn` toast says so, at the path's labels: "Lamp › Brightness: Applied to 1 of 3 other nodes. kitchen-lamp: offline". It comes once a burst of writes, such as a drag, has been quiet for half a second. Absent nodes only show on their tabs: nodes that differ are expected.
- **The switch** is the header's button beside the tabs, solid while on. It starts off on each load, since a change sent to every node by mistake costs more than a click, and turning it off clears the marks.

## 7. Data and reactivity

### 7.1 Store

One store per connected node (and per peer behind a UI host):

- `schema`: the UI model, built from schema fetches (§7.2)
- `values`: a sparse JSON tree of what is visible or used by conditions
- `pending`: writes sent and not yet answered, by path
- `errors`: the last error per path, cleared by the next successful write or by navigation

Widgets bind to paths and re-render when their value changes (Svelte runes on the web; explicit setters on LVGL).

### 7.2 Schemas

- **Fetching:** `get <page path>?view=schema` with `depth` 3 for a page, deeper on demand when the user opens a sub-page or collapsible group. A table needs its list's whole element schema, which `depth` cuts like an object's children (a list at the limit has no `items`): lists left incomplete are fetched on their own, without a depth limit that matters (16). Over NowTP, responses are capped at 16 KB; on `too_large`, retry with `depth` 1 and fetch the children one by one (`keys`). So on `busy` with "not enough memory for the response": a node without PSRAM refuses a NowTP or UDP reply that its largest free block can't hold (TesserAPI dba7c1f), and a smaller one may fit. At `depth` 1, the read waits and is asked again (0.5, 1, 2, 4 s). Either way, nothing toasts.
- **Caching (web):** in `localStorage`, keyed by the node, schema hash, path within the node and depth. The node is what the page knows of it: its API's URL (the bridge's proxy gives each node its own, `…/n/<host>/api`), or the line's key (`serial`, `ble:<id>`), with its identity (§7.5: its hash and device id, read on each connection), so another device with the same firmware at the same address doesn't get the first one's root (its `id`). So a host that answers with another node's hash (any LAN host the bridge finds over mDNS becomes a launcher's session) caches what it serves under its own URL, never read for the other node.
  - For a peer behind a UI host, the hash is the `schema` key of its stub in the parent's schema (TesserAPI §14.1), and the node is its gateway, at the stub's path.
  - For the node reached directly, it is the node's `view=hash` of `/` (TesserAPI §7), read once per load: one small request instead of the schema. It is the hash of the schema this client may read, so clients with different access levels don't share entries. A node that doesn't support it (`bad_request`) is read whole on every load.
- **Gateways:** a gateway's own schema contains remote stubs, whose `online` keys change its hash. Cache the schema of each remote subtree separately, under its peer's hash. When a stub changes during a session (§7.3), the node's hash is dropped until the next load, so nothing is cached under a hash that no longer holds.

### 7.3 Subscriptions

TesserAPI allows 4 subscriptions per client (default `maxSubscriptionsPerClient`). The renderer uses at most 3 for what is on screen, and a fourth for events:

1. **The page:** `sub <page path>` with `keys` = the visible children and `depth` = the visible depth (a list's element objects count, a level below the list), `interval` 100 ms. Navigating unsubscribes the old page before subscribing the new one. The snapshot fills the store, replacing what it covers: a child the store has and the snapshot doesn't (a node removed by a firmware update) goes, down to `depth` (objects below it come as `{}`, cut, and are kept) and, at the page's level, among its `keys`. So does each polled read. On `too_large`, subscribe with `snapshot: false` and read the visible cards with one get each.
2. **The peer's stub,** while the page is a peer's (`/peers/<name>/...`): `sub /peers` with `keys` = the peer and `depth` 1, for its online state. A page showing links needs nothing extra: unmirrored remote nodes are part of its subscription and read as `null`. A notification carrying `{"<name>": null}` means that peer changed (mounted, online state, schema hash): re-read its stub with `/peers?view=schema&depth=1&keys=<name>`.
3. **Condition paths** outside the page, when there are any.
4. **The tree's events,** for those that toast wherever the user is (§7.8): `sub /` with `changes: false` (TesserAPI §11: events only), `snapshot: false` and `interval` 60 s, which keeps firmware that predates `changes` to one change notification a minute. It is subscribed after the page's, kept across pages, and subscribed again after an `unsub /`. Over HTTP, it is a streamed `GET` (§9.2). When the node refuses it (`busy`, `not_allowed`; over HTTP, also an answer that isn't a stream: older firmware), there are no toasts from other pages; nothing is polled for it.

The page subscription leaves out mirrored remote children (their copies would come along) and `ui.page` sub-pages (they subscribe themselves). Specs for the same path are merged into one subscription, since `unsub` removes every subscription of a client at a path. Beyond 3 subscriptions, or when the node answers `busy` or `not_allowed`, the rest is polled once per second; a subscribe that times out (an offline peer) is retried every 5 s.

A `busy` for lack of memory (§7.2) is the snapshot's size, not the node's budget, so the subscription isn't polled instead: polling would ask for the same reply every second. The page is read in pieces, one get per key or child, and the subscription is tried again after 5, 10, 20, then every 40 s, without a toast; a read that gets it is read in pieces too. Through a gateway, the snapshot that fails is the remote's. Since TesserAPI 49dd339, a gateway's upstream subscription asks the remote for the union of what its local subscribers need (their `keys` and deepest `depth`, TesserAPI §14), so subscriptions below a remote node stay as tight as the page: `keys` and `depth` always, one subscription per page rather than one per child. Before it, the upstream took the whole subtree, and a page at a peer's root cost the peer its whole tree.

Notifications are merge patches: apply them to `values` exactly as TesserAPI applies a `set` body. On `"overflow": true`, re-read the page with a get. Events (`op: "event"`) under what the page watches go to the `events` or `log` widget of their path, or to its nearest ancestor section, unless `ui.hidden`; each keeps its last `ui.lines` (§5.2). Whatever their path, those with `ui.toast` are also a toast; one whose schema isn't loaded yet (below the depth read so far) has it read first.

### 7.4 Writes

- **Apply to all** (§6.6) sends each of these writes to the other nodes too.
- **Values:** the widget updates the store at once (optimistic) and marks the path pending, then sends `set <path> <value>`.
  - Sliders, knobs and color pickers send at most one write per 100 ms while dragging, and always the final value.
  - The reply is the value read back: it replaces the optimistic one and clears `pending`.
  - While a path is pending, notifications for it are held back, so the control doesn't jitter, and applied when the reply arrives.
- **Errors:** an error reply restores the last confirmed value and shows the message on the widget at the error's `path`. If that path isn't visible, on its nearest visible ancestor; with none on screen (the page root, another page after navigating), as an error toast (§7.8). `"partial": true` adds "some changes were applied".
- **Actions:** `set <path> <arg>`. `confirm` asks first. A button is disabled while its call is in flight. A reply other than `null` is shown next to the button, and errors appear as for values. The login action (`ui.auth: "login"`), wherever it is drawn, signs the UI in like the sign-in dialog.
- **Keep-alives** (`ui.keepalive`), for dead-man timers: a device that stops a motor unless its manual output is rewritten within a timeout, so a closed tab or a lost connection can't leave it turning.
  - A writable number or boolean is re-sent every `keepalive` ms while it isn't neutral (0 or `false`), its control is on screen (not on another page or in a closed group), the tab is visible, the connection is open and the control is enabled. Otherwise the device's timer stops it.
  - What's re-sent is the value on screen: a device that sets it back to neutral (its timeout, a disable) ends the keep-alive.
  - A kept-alive number has a button beside its control that sets it to 0, since dragging back to exactly 0 is hard.
  - Re-sends aren't edits: nothing is pending, so notifications keep reaching the screen, and none is sent while a write to the path is in flight. An error ends the keep-alive until the next edit.
  - A `hold` action repeats its `true` call the same way while held (every 300 ms by default), and calls `false` on release, cancel, blur, a hidden tab or leaving the page.
- **Forms** (`ui.form` objects): edits stay in a local draft, shown as modified. Submit sends one patch to the object with the edited values and the submit action, either `ui.submit` or the first action: `{"az": 120, "el": 30, "go": null}`. TesserAPI validates every value before applying any and runs the action after the values (TesserAPI §6.3), so the form is atomic up to the action. Success clears the draft; errors highlight fields by `path`. Reset discards the draft.
- **Authentication:** an `unauthorized` reply opens a sign-in dialog (web). The token it yields is kept in `localStorage` and sent as `?token=` on the WebSocket handshake and as `Authorization: Bearer` with HTTP requests.
  - **Login action:** when the tree has an action with `ui.auth: "login"` (TesserKIT's `/sys/auth/login`), the dialog shows its argument's string fields (`secret` ones as passwords) and calls it. The reply is the token, as a string or as `{"token": ..., "access": ...}`. The header offers "Sign in" and, once signed in, "Sign out".
  - **Without one,** the dialog asks for the token itself (a node using `HttpServer::setToken`).
  - **Access levels:** the schema's `access` (TesserAPI §13.1) is inherited down the model. When the tree has an action with `ui.auth: "whoami"`, the renderer calls it after loading the schema, and its reply (a level, or `{"access": level}`) is the client's level: controls needing more are disabled. Without it, the level is unknown and nothing is disabled; the device's `unauthorized` replies still apply.
  - **Signing in or out** changes what the node shows (hidden nodes, TesserAPI §13.1): the schema is read again and the WebSocket reconnects with the new token.

### 7.5 Connection state

- **Transport down:** a banner, and controls are disabled. Reconnect with backoff (0.5, 1, 2, 5 s). A toast says the connection is back.
  - **The same node?** Each time the connection opens, the node's `view=hash` and its root at `depth` 0 (its device `id`, TesserAPI §14) are read again. If both match what was read last, the current page is re-subscribed and the snapshot refreshes the store. Otherwise (new firmware after an update, a node that rebooted with another tree, another device at the address after a DHCP change) everything is read again, as on the first connection: the schema, the views, the values and the subscriptions.
- **Requests** time out after 6 s: a gateway's NowTP calls time out after 3 s, plus Wi-Fi.

### 7.6 Peers behind a UI host

- A `link` widget shows a remote node's name, its `label` (from the peer's root schema, once fetched), and its online state from its stub.
- Opening it navigates to `#/peers/<name>`. The page path is then `/peers/<name>/...`: every request goes through the gateway (forwarded gets and sets, forwarded subscriptions, TesserAPI §14).
- **Offline peers:** the page shows "offline" and disables controls. When the peer returns, the gateway's renewed subscription sends its whole state, and controls come back.
- **Mounted peers in the schema:** a stub without `online: false` is reachable.

### 7.7 Charts

A chart keeps its own history: each value received for its path (snapshot and notifications) is stored with the time it arrived, up to `ui.history` seconds. Nothing is stored on the device. A chart's path is added to the page subscription even when it is hidden behind a collapsed group, so history keeps accumulating while the page is open.

The vertical axis follows the values shown: their extent, widened around its middle to at least ten units of the displayed precision (`precision` 2: 0.1), so noise in the last digit stays a ripple, and kept within the value's `min` and `max`. The range bounds the axis but doesn't fix it: a target within 0–360° isn't drawn as a flat line at the bottom. Without a precision, a constant value gets an axis of ±1.

The line runs from the first value received to now, and a dot marks the latest value: a value that doesn't change is read once, and its line only grows from when the page opened.

### 7.8 Notifications

Toasts tell what has no place on screen. Inline errors stay the rule: a toast never repeats what a widget shows.

| Source | Shown as |
|---|---|
| A write or call error at a visible path (or below one) | Inline only (§7.4). |
| Validation of values and forms | Inline only. |
| An error with no visible path above it | An error toast, led by the node's parent's and own labels ("Lamp › On"), linking to the page that shows it. |
| An `unauthorized` reply | The sign-in dialog, no toast. |
| An event with `ui.toast`, on any page | A toast of its kind, led by the event's parent's and own labels ("Wi-Fi › Joined") linking to the page that shows it, then its payload. With `ui.hidden`, nothing else shows it. |
| The connection lost | The banner (§7.5): a state, not a moment. |
| The connection back, signing in or out | An `ok` toast. |
| A view's item whose schema can't be read (a peer without that path, under an `each`) | Inline only: the item says "unavailable". |
| Subscription fallbacks, `too_large` retries | Nothing. |

- **Kinds:** `info` and `ok` stay 3 s, `warn` 6 s. An `error` stays until dismissed, or until a successful write or call at its path or above it, like inline errors (§7.1). Navigation doesn't clear toasts.
- **Repeats:** a toast with the same kind, text and path as one shown is counted on it ("×3") and its time restarts, instead of stacking.
- **At most 3:** a fourth removes the oldest, errors last, never the new one.
- **Timers wait** while the pointer or the focus is on the toasts and while the tab is hidden; they then leave a second at least.
- **Web:** bottom right, bottom centre below 800 px wide. One polite live region; `warn` and `error` toasts are alerts. Each has a dismiss button, and none takes the focus. Custom elements raise toasts through `tesser.toast()` (§9.8), applications through the store's `toasts` (§9.9).
- **LCD:** the same queue and rules, as labels at the bottom of the screen (§10.3).

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
| `{"card": label, "items": [items]}` | A card. A card holding one custom element doesn't repeat the node's label above it, unless the item gives a `label`. With `"wide": true`, the card spans the page's full width, on a row of its own; otherwise cards share columns at least 360 px wide. In C++, a hint on the page right after the card: `page.card("Recorder").widget("x-recorder", "/recorder"); page.hint("wide", true);`. |
| `{"text": s}` | A paragraph. Plain text; `**bold**` is the only markup. |
| `{"each": path, "item": item}` | The item repeated for each child of the object at `path`, with `$` replaced by the child's path. With `/peers`, one entry per discovered node. |

- A `widget` item may name a custom element (§9.8) over any path, an object included. A view whose only item is one is a **custom page**: the element alone, the page's full width.
- The renderer shows view pages first, before the node's own tree: the first menu entries (§6.3), or tabs without the menu. Route: `#/v/<id>`. A remote node's views show in its tab (§6.5), at `#<node>/_ui/<id>`.
- A view's subscriptions follow §7.3: one per distinct remote node involved, plus one local, within the budget of 4. Each is at the deepest path covering what the view shows of that node, with `keys` naming the children it shows there, so a gateway asks a peer for no more (TesserAPI §14). When a page involves more than 3 nodes, the renderer subscribes to the nodes on screen and falls back to polling (one get per second) for the rest.
- `Views` stores its declaration as C++ structures of string literals and renders the JSON on request: no JSON document at rest. A UI host may instead serve a JSON file from its filesystem through a `custom` node with the same name and format.

## 9. Web renderer

### 9.1 Structure

```
web/
  src/client/      envelope client: WebSocket, HTTP, Web Serial and Web Bluetooth transports
  src/model/       schema → UI model (§4, §5), conditions, formatting, views
  src/store/       values, pending writes, merge patches, subscriptions, the session
  src/widgets/     one Svelte component per semantic widget; registry.ts maps names to them
  src/Item.svelte  recursive renderer: dispatches on the model node's kind and widget
  src/App.svelte   routing, connection state, the device list
  src/main.ts      the bundle a node serves (ui.js); src/lib.ts the npm module (§9.9)
  src/launcher/    the launcher's own script (launcher.js, §9.7.2): its workspace and connection screen
  src/flash/       the launcher's flasher (flash.js, §9.7.1)
  test/            vitest: model and store against schema fixtures; golden models (§11)
  e2e/             Playwright: the built bundle against the host node (§11)
```

**Adding a widget:** its rules in `model.ts` (`fits()` and inference), its component in `widgets/registry.ts`, and its row in §5.1. Custom elements need none of this.

### 9.2 Client

- **WebSocket** (default): `ws://<host><wsPath>`, one envelope per text frame (TesserAPI §10.1). Numeric ids, a 6 s timeout per request. Notifications are routed by path to the store.
- **HTTP fallback** when the WebSocket can't connect (a node without `enableWebSocket()`):
  - reads with `GET <api>/<path>?view=&depth=&keys=`
  - writes with `PUT`
  - the visible page is polled once per second
  - the tree's events (§7.3) come over a streamed subscription (TesserAPI's `HttpServer`): `GET <api>/?sub&changes=false&snapshot=false&interval=60000`, with the token as for any request. The node answers `200` with `Content-Type: application/x-ndjson`, one notification per line, exactly as over WebSocket, and a bare newline after 15 s without one; the subscription lasts as long as the connection. It is read with `fetch` and a body reader, since `EventSource` can neither send the token nor ask for local network access. A stream that ends, or stays silent for 40 s, is opened again with backoff (1 s up to 30 s); signing in or out opens it again with the new token. Any other answer is a refusal: an error (`busy` beyond the node's streams, 2 by default), or a plain JSON value from firmware without streams.
- **Web Serial** (§9.7): newline-delimited envelopes. Lines that don't start with `{"` are ignored, and parsing starts at the first `{"` of a line, since ESP log output can interleave. A bare `\n` is sent after opening, because opening the port resets most devkits.
- **Web Bluetooth** (§9.7): the same lines over the Nordic UART Service. Writes go to its RX characteristic with a response, in chunks of up to 512 bytes, one at a time (longer than the MTU, they become long writes). Replies come as indications on TX, in pieces of the MTU that the same line reader joins.
- **Configuration:** `window.TESSER` in the page, or the defaults `/api` and `/ws` on the page's origin. The same options are `mount()`'s (§9.9):

  | Key | Meaning |
  |---|---|
  | `api`, `ws` | API base and WebSocket URL; `ws: null`: HTTP only. The WebSocket defaults to `/ws` on the API's host. |
  | `transport` | `ws`, `http`, or `serial` and `ble`, which wait for the user to choose a device (§9.7). |
  | `minVersion` | The oldest bundle the node accepts: older ones show a warning. |
  | `title` | The page title until the device's label is known. |
  | `scripts` | Module scripts defining custom elements, resolved against the page (§9.8): the only way to load one from another origin. |
  | `theme` | CSS variables without their `--`: `{"accent": "#d97706", "radius": "4px"}`. They apply in both color schemes. |
  | `strings` | The interface's text (§9.10). |
  | `path` | The path the UI starts from and doesn't go above: a subtree, or a peer. View pages show only when it is `/`. |
  | `header` | `false` hides the top bar; a lost connection still shows a banner. |
  | `menu` | The navigation menu (§6.3). Default: on for the node's own page, off when embedded; always off without the header. |
  | `tabs` | Remote nodes as tabs (§6.5), with the menu. Default: on; the header's button overrides it in the browser. |
  | `routing` | `hash` (default) follows `location.hash`; `memory` keeps the route inside the UI, for pages that own the URL. |
  | `launcher` | `true`: the page is a launcher (§9.7) despite having a configuration. |
  | `firmware` | Firmware the launcher installs over USB (§9.7.1): `{images, wifi, manifest, flasher}`. |
  | `bridge` | The bridge's macOS executables the launcher links to (§9.7): `{repo, name}`, `<name>-macos-arm64.zip` and `-x64.zip` on `repo`'s latest release. Default: TesserUI's, `{repo: "leokeba/TesserUI", name: "tesserui-bridge"}`. |

  For development, the query string overrides the page's: `?api=http://<ip>/api`, `?ws=` (empty: HTTP only), `?transport=serial`.
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
- **Options** (before `serve()`): `basePath("/ui/")` serves the page there and the bundle next to it, leaving `/` to the application; `title()`, `theme(var, value)`, `text(english, translation)` and `script(url)` fill the configuration of §9.2; `asset(uri, data, size, type, gzipped)` serves a file from flash, such as a custom element's script (one handler slot each).

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

### 9.7 Launcher (GitHub Pages)

The launcher, published on GitHub Pages by CI from `main` (`https://leokeba.github.io/TesserUI/`), connects to nodes the user picks, several at once (§9.7.2). A page without `window.TESSER` is a launcher: every node's page sets it, so this means Pages, a CDN's `index.html`, or the dev server. A page that sets `window.TESSER = {launcher: true, ...}` is a launcher too, with the rest of its configuration (`title`, `theme`, `strings`...): another project's launcher on its own Pages. The launcher is a script of its own, `launcher.js`, built from the same sources as `ui.js` with what only a launcher needs: Pages and `index.html` load it, and `ui.js` loads it from beside itself on any other launcher page, so a node's page never does. Until a node is connected, it shows a connection screen:

| Way | How | Browsers | Use |
|---|---|---|---|
| **USB** | Web Serial to a `LineTransport` (`?transport=serial`) | Chromium on desktop | A node with no radio at all; debugging; a **NowTP gateway on USB**: a board that mounts the NowTP nodes around it (`examples/arduino/UsbGateway`, `examples/idf/usb_gateway`), so a laptop reaches a field with no Wi-Fi. |
| **Bluetooth** | Web Bluetooth to TesserAPI's `BleTransport` (`?transport=ble`, `examples/arduino/Bluetooth`, `examples/idf/bluetooth`) | Chromium on desktop and Android | A phone next to a node, with no Wi-Fi in common. |
| **Network** | An address, opened as `?api=http://<address>/api` | Chromium (local network access) | A node on the network, without flashing the bundle into it. `name.local` works for a node that announces itself (`HttpServer::advertise()`). |
| **Nearby** | The nodes the bridge finds over mDNS, through its proxy | Chromium and Firefox from Pages; any browser from the bridge's own page | Finding the nodes on the network, live. |
| **Bluetooth serial** | Web Serial to a paired SPP device (`examples/arduino/BluetoothSerial`), offered with the USB ports | Chromium, Android included | A phone and an original ESP32, as a serial line. |

- **Mixed content:** an HTTPS page can't reach `http://` or `ws://` devices, except as Chrome's Local Network Access allows: after the user's permission, `fetch` to a private IP literal, a `.local` name, or a request marked `targetAddressSpace: "local"` (which the HTTP client adds for `http://` URLs from an HTTPS page). WebSockets aren't covered, so such a node is polled over HTTP, its events streamed (§9.2), and the node must enable CORS. Loopback (`localhost`, `127.0.0.1`) is trustworthy: a node there, such as `scripts/device.mjs`, is live over its WebSocket.
- **The bridge** (`bridge/`, the npm package `tesserui-bridge`: `npx tesserui-bridge`) runs on the user's machine and does what a page can't, on `localhost:8765`:
  - it browses mDNS for `_tesser._tcp` services (what `HttpServer::advertise()` announces: the API's paths in the TXT record), with legacy unicast queries from an ephemeral port, so the system's own responder keeps port 5353; it lists them, with the serial ports, at `GET /nodes`, labelled from each node's schema;
  - it proxies each node's API (`/n/<host:port>/api/...`), WebSocket (`/n/<host:port>/ws`) and other files, read only (`/n/<host:port>/ext/x.js`, custom elements' scripts, §9.8): a page reaches `http://localhost` and `ws://localhost`, which Chromium and Firefox trust from HTTPS, so a node is live through it, not polled; responses are passed on as they come, streams included, and a request ends when the page goes away. Request bodies stream through too, with their `Content-Length` (a node reads no chunked body), so a firmware upload (1.7 MB at 50–70 KB/s over the node's Wi-Fi) goes at the node's pace: the node has 30 s to take each piece, and a minute after the last to answer (the system's buffers may still hold seconds of the body, then the node checks the image); a request without a body has 30 s for its answer to begin. Under Bun, whose `fetch` sends a stream chunked (1.3.6), the body is read whole first, and the node also has the time to take it at 8 KB/s;
  - it carries serial ports over WebSocket (`/s/<path>`), one page per port, for browsers without Web Serial;
  - it serves the launcher at `/` (`index.html`, `ui.js`, `launcher.js`, and the flasher at `/flash/`), marked with `<meta name="tesserui-bridge">`, which works in every browser: Safari (WebKit) refuses `http://localhost` from an HTTPS page. The page is `--page`, else the bundle's `index.html`. The project's own files beside it (`scripts` for custom elements, images...) come with `--file <name>=<path>`, or `--file <path>` under its base name: a name may have folders, never `.` or `..`, and never one of the bridge's own paths (`index.html`, `ui.js`, `launcher.js`, `nodes`, `flash/`, `firmware/`, `n/`, `s/`), which are refused rather than overridden (`bridge/files.mjs`). Each is served with a type from its extension, binary files as they are;
  - it serves the firmware the page installs (§9.7.1) from a repository's latest GitHub releases (`--repo`, by default `leokeba/TesserUI`), at the paths a site has them: `/firmware/manifest.json`, then `/firmware/<tag>/<asset>`, only the images the manifest lists. Not being a page, it reads release assets despite their lack of CORS. The manifest is kept 5 minutes (GitHub's API allows 60 requests an hour without a token; `GITHUB_TOKEN` lifts it), a stale one served while GitHub fails, and each image once fetched.
  Only pages from the launcher's origin (`--launcher`, by default `https://leokeba.github.io/TesserUI/`, and TesserUI's), from localhost, or from `--origin` may use it, and it only reaches the nodes it listed. `--node host[:port]` adds a node by hand.
- **The bridge as a macOS executable,** for Macs without Node: `bridge/scripts/macos.mjs` has Bun compile it for each architecture, with a project's launcher built in: its page and its own files (`--file`), TesserUI's `ui.js`, `launcher.js` and flasher, the launcher's URL and the repository whose releases it installs (the defaults of `--page`, `--launcher` and `--repo`). Each zip (`<name>-macos-arm64.zip`, `-x64.zip`) holds one executable, `<name>`, which a double-click runs in a Terminal window. TesserUI's releases carry `tesserui-bridge`, its own launcher with its firmware; another project's release workflow calls the reusable `.github/workflows/bridge.yml` with its page, a name, its release's tag and its page's own `files` (paths in its repository, one per line, served under their base names, or `name=path`), and its launcher links to it with `bridge`. The executables are signed ad hoc after Bun, whose payload leaves the linker's signature invalid (a quarantined download with an invalid signature is "damaged", with no way to open it); not notarized, so macOS asks once to open one anyway (*Privacy & Security*, *Open Anyway*). They have no serial ports: Bun's bundler breaks serialport's bindings (Bun 1.3.6).
- **Nearby:** on Pages, the launcher asks the bridge only when the user clicks *Look for the bridge*, since Chrome asks before a public page reaches localhost; after a first answer, and on the bridge's own page, it asks every 5 s. `?bridge=` names another bridge. The nodes it lists join the workspace (§9.7.2).
- **Signing in on a line:** serial and Bluetooth lines have no handshake, so the token goes in TesserAPI's `auth` envelope (TesserAPI §10.4): the stored one after each connection, the new one after signing in (through the login action, or a token typed in), an empty one to sign out; then the schema is read again and the subscriptions are made anew, since they keep the level they were made at. A token answered with `public` is stale, and forgotten. Tokens are kept per Bluetooth device (Chrome keeps its id across visits) and for serial ports as a whole (a port has no stable identity). Older firmware answers `bad_request`: nothing changes.
- **A board that resets:** opening a serial port resets most devkits, and a Wi-Fi node then takes seconds to boot (7.6 s for TesserAPI's test firmware) before it answers. The first request is asked again every 1.5 s, for up to a minute, before the schema is read.
- **Tokens** are kept per node (by API URL), since one origin talks to all of them.
- **Links:** `?api=` makes a node's page shareable: `https://leokeba.github.io/TesserUI/?api=http://192.168.1.20/api#/motor` joins that node to the workspace and shows it.
- **Android:** Chrome on Android has no Web Serial over USB, only Bluetooth serial ports, which the USB chooser lists (`allowedBluetoothServiceClassIds`: SPP). Phones use Bluetooth LE, Bluetooth serial or the network. The Bluetooth serial example is not yet tried on hardware (pairing needs a person).
- **Bluetooth throughput,** measured from an ESP32 to a Mac: on ESP-IDF (NimBLE, notifications) about 60 ms per request and 13 KB/s for long replies; on Arduino (confirmed indications) about 120 ms and 6 KB/s. A node's schema loads in a second or two. A Bluetooth client isn't authenticated (anyone in range can connect): it has the `public` level, and the node's authorizer decides what it may change.
- **On a node's own page**, `serial: true` in `window.TESSER` shows the connection screen without the network way.

### 9.7.1 Installing firmware

A launcher can install firmware on a board over USB, as ESPHome's web installer does, then take the board through its first steps. The firmware comes from the GitHub releases of the project the launcher belongs to: TesserUI's own launcher offers its USB gateway and Bluetooth examples, TesserKIT's its example firmwares.

```js
window.TESSER = { launcher: true, title: 'TesserKIT', firmware: {
  images: [{ label: 'Full', asset: 'tesserkit-full-{target}-factory.bin', description: 'Every service' },
           { label: 'Minimal', asset: 'tesserkit-minimal-{target}-factory.bin' }],
  wifi: '/sys/network/wifi' } };
```

- **Images:** `asset` names a release asset, with `{target}` (`esp32`, `esp32c3`, `esp32s3`...) and `{version}` (the tag without its `v`), as TesserKIT's `fw.github()` names them. It is a whole-flash image written at 0x0: `merge_bin`'s output, TesserKIT's `<name>-<target>-factory.bin`. `transport: "ble"` marks a firmware reached over Bluetooth afterwards rather than over its serial port. The user can also pick a file of their own.
- **Releases on the launcher's site:** a page reads GitHub's API (it sends CORS headers) but not the release assets, which come from a host that sends none. So CI copies the images of the latest three releases into the site: `node web/scripts/firmware.mjs <owner/repo> _site/firmware` writes `<tag>/<asset>` and `manifest.json` (`{repo, releases: [{tag, date, assets: [{name, size}]}]}`, newest first, without drafts and pre-releases), which the flasher reads (`manifest`, by default `firmware/manifest.json`). About 9 MB a release for TesserKIT's six images. `bridge/releases.mjs` finds them, for this script and for the bridge.
- **The flasher** is `flash.js` (`web/src/flash/`, built by `vite build --mode flash` into `dist/flash/`, with the stub flashers esptool-js loads per chip): a separate script, outside the budget (§2), loaded from `flasher` (by default `flash/flash.js` next to the page) when the user clicks *Install firmware*, which shows only on a page with `firmware` and Web Serial. A node's bundle has the button and the `import()`, nothing more. It runs [esptool-js](https://github.com/espressif/esptool-js) (Espressif's esptool in the browser) and its own Svelte UI in the launcher's card, with the launcher's styles and `strings`.
- **Steps:** the user picks the firmware and a version (only those with an image for some chip), then the port; esptool-js resets the board into its bootloader and identifies it; the page names the chip and MAC and asks before writing (a release without an image for that chip says so and stops); the image is downloaded, written with compression, and the board restarted. *Erase the whole flash first* also erases what the image doesn't cover: the other OTA slot, files, the core dump. The image itself covers NVS (0x9000) with its padding, so an install resets the board's settings whatever is chosen.
- **Speed:** the stub flasher asks for 460800 baud, which reopens the port. A devkit's USB-to-UART bridge resets the board then, and esptool-js goes on at 115200: about 107 s for TesserKIT's 1.8 MB image on an ESP32 devkit. A chip's own USB (the C3's and S3's) keeps the faster rate. Talking to the ROM at 460800 from the start fails on an ESP32 devkit. Such a chip leaves with its reset and comes back as another port, which the flasher finds among the page's ports by its USB identity.
- **After the install,** the flasher opens the port as the USB way does and waits up to a minute for the firmware to answer. If `wifi` names TesserKIT's Wi-Fi service (its DESIGN.md §5.2) and the firmware has it, it asks which network to join: the device's `scan`, strongest first, a network name, a password; the network goes first in the keyed `networks` list, the others rewritten by name alone so they keep their passwords. It follows `status` until the device has an address (45 s at most, the device's own words in the meantime), and offers *Open it over the network* (`?api=http://<ip>/api`) or *Stay on USB*. A device that joins a saved network on its own while asked skips the question. Then the launcher's session takes the line the flasher opened (`useSerial()` takes a client too): opening the port again would reset the board. A firmware that doesn't answer gets a word saying so; a Bluetooth one, the Bluetooth chooser.
- **On the bridge's page:** the bridge serves the flasher and the firmware of its repository's latest releases at the paths a site has them (§9.7), fetched from GitHub when asked, so a project's executable installs its firmware with nothing but GitHub. `localhost` is a secure context: Web Serial works there.
- **Through the bridge's serial ports** *(later)*: browsers without Web Serial would need them to carry DTR, RTS and the baud rate.

### 9.7.2 The workspace

A launcher holds several connections at once, so the user moves between all the nodes they reach without leaving the page. Each connection is a session of its own (client, store, subscriptions), and every node of every connection is a tab (§6.5).

- **Tabs:** each connection's node, then its remote nodes, in the order the connections were made. A `+` (*Another node*) opens the connection screen, the others staying connected, and the header's `×` closes the connection shown and forgets it. A remembered connection that isn't open (a port or a device that needs a click) is a tab too, dimmed: choosing it opens the browser's chooser for it.
- **One tab per device:** a node reached several ways (by its address, through the bridge, by USB, mounted by one or more gateways) is one tab, by its device id: a node's own `id` at the root of its schema, a remote node's in its stub (TesserAPI §14.1). A connection to the node itself wins over a gateway mounting it, and the first connection or gateway over later ones. A connection whose node another one already shows has no tab; one the bridge brought is closed. Nodes without an id (firmware before TesserAPI b852626) are each a tab.
- **Shown and not:** only the shown connection's page is subscribed (§7.3). The others keep their events subscription and their remote nodes' parents at depth 1, for the tabs' online states. Each connection keeps its route while another is shown.
- **Remembered:** the connections the user made are kept in the browser (`tesserui:nodes`) and opened again on the next visit:
  - network: by API URL and WebSocket;
  - USB: by the port's USB vendor and product ids, the n-th port with them. A port this page was given before (`navigator.serial.getPorts()`) opens without the chooser. Opening it resets most devkits, so every visit restarts them;
  - Bluetooth: by the device's id, through `navigator.bluetooth.getDevices()` where Chrome offers it; otherwise its tab waits for a click.
  A line without an identity (a port without USB ids, the flasher's) isn't remembered. The connection shown last is shown again, unless `?api=` names one.
- **The bridge's nodes** (§9.7, *Nearby*) join as connections of their own, through its proxy, unless a connection already reaches the device (the bridge lists its `device` id, from its mDNS record or its schema). They aren't remembered: the bridge finds them again. A node closed by hand doesn't come back until the next visit.
- **Apply to all** (§6.6) spans every connection: a write goes to every tab's node, through its own connection.

### 9.8 Custom elements

What the generic widgets can't show (a map of a heliostat field, a sky dome, a wiring diagram) is a **custom element**: a standard web component, written with any framework or none, that TesserUI hosts.

```cpp
auto& sky = api.object("sky").ui("widget", "x-sun-dial").ui("script", "/ext/sun-dial.js");
sky.value("sunAz", sunAz).watch();  sky.value("targetAz", targetAz).range(0, 360);  // ...
views.page("sky", "Sky").widget("x-sun-dial", "/sky");   // the same element as a whole page (§8)
```

- **Examples** (`examples/elements/`, served at `/ext/` by the host demo node): `sun-dial.js` (the sky and a target), `sky.js` (a heliostat's sky: sun, target, the mirror normal between them, named sources), `keyframes.js` (a keyframe editor over lists of `{t, value}`, with a playhead and the object's `start`, `stop` and `clear` actions). They are not part of the bundle.
- **Naming:** `ui.widget` with a hyphen, the HTML rule for custom element names. It fits any node: a value, an action, a list, a custom node, or an object, which the element then draws whole (its subscription has no depth limit).
- **Script:** a module script defining the element, from `ui.script` on the node (resolved against the node's API, so a UI host serves it for its peers; a path from the root, `/ext/x.js`, against the folder above the API: the node's root, `http://node/` for `http://node/api`, and the node's folder of the bridge's proxy for `…/n/<host>/api`. An API more than one level deep moves it: `/v1/api` takes `/v1/ext/x.js`) or from the page's `scripts` (resolved against the page). Each URL loads once per page.
  - A script runs on the page's origin, which may hold tokens (a launcher keeps every saved node's), and a peer's schema reaches the page through its gateway. So `ui.script` is only a path on the node: no scheme, no `//`, no `%` or `\` (a server could decode them past the check), nothing that resolves outside the folder above the API, nor inside the API itself, whose answers a peer may shape (`/api/peers/<name>/files/x`). A refused script is logged and counts as one that failed to load: the inferred widget stands in. Scripts from elsewhere come only from the page's `scripts` (`web/src/widgets/script.ts`). A node can serve it from flash with `WebUi::asset()`.
- **Properties** TesserUI sets, and updates as they change:

  | Property | Value |
  |---|---|
  | `value` | The node's value (an object's whole subtree), a copy: 64-bit integers as `BigInt`. |
  | `schema` | The node's schema, hints included. |
  | `label` | The node's label. |
  | `disabled` | No connection, the peer is offline, or `enabledWhen` fails. |
  | `error` | The last error at the node's path, or `null`. |
  | `tesser` | `get(path)`, `set(path, value, drag)` and `call(path, arg)` (a promise of the result; rejects with the error body). Paths are relative to the node, `""` being the node itself, or absolute within the node's tree. `set` is optimistic and reconciled like any write (§7.4); `drag: true` throttles it. Setting an object writes a patch, validated whole. `toast(text, kind)` shows a notification (§7.8), `info` by default. |

- **Fallback:** if the element isn't defined within 8 s, its script fails to load, or it throws when created, the tier 0 widget is drawn instead (an object's values as JSON). Elements must not set attributes in their constructor (the HTML rule).
- **Styling:** the interface's CSS variables (`--accent`, `--text`, `--surface`...) reach into shadow roots, so elements follow the theme and the color scheme.
- **LCD:** not rendered; the tier 0 widget is used.

### 9.9 Embedding

The npm package's module (`import {mount} from "tesserui"`) puts UIs into an application's own pages:

```js
const ui = mount(document.getElementById("motor"), {
  api: "http://heliostat.local/api", path: "/motor", routing: "memory", header: false,
});
ui.destroy();
```

- **Options** are §9.2's. `mount()` returns the `Session` (values, writes, subscriptions, and notifications: `session.store.toasts.show(text, kind)`, §7.8) and `destroy()`.
- **Several UIs** on one page each have their own session and connection; their styles are scoped to the `.tesserui` element they render into, and leave the page's alone.
- **Custom UIs** can use the same pieces without the generic renderer: the client, the store, the model (`buildPage`, `buildView`, conditions, formatting), exported with their types.
- **Local devices from public pages:** Chrome's Local Network Access asks the user before a public origin reaches a device on the local network.

### 9.10 Interface text

Numbers use the decimal separator of the browser's language ("0,25"), which native number inputs show and the page can't change, so readouts match them. Nothing else is localized: no digit grouping.

The renderer's own text ("Advanced", "Apply", "Offline"...) is English, replaced through `strings`, keyed by the English text: `{"Advanced": "Avancé", "{n} modified": "{n} modifiés"}`. `{name}` placeholders are kept. Labels, units and descriptions come from the device, which localizes them itself.

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
| `events` | a toast (§7.8), when `ui.toast` says so |
| `table` | `lv_list` of rows; a row opens its element as a page |
| `link` | a menu entry with an online dot |
| `confirm` | `lv_msgbox` |
| `json`, `color` | not rendered *(color later)* |
| custom elements (§9.8) | the tier 0 widget |

- **Units:** LVGL's built-in Montserrat fonts cover ASCII and `°`. Other units (`µ`, `Ω`) need the application to provide a font, set with `ui.font()`.
- **Monochrome displays** (SSD1306 128×64 with buttons or an encoder) *(later)*: a compact profile with one row per line, no cards, and value editing on a focus-and-edit screen.

## 11. Testing

1. **Schema fixtures:** JSON schemas and value trees captured from real firmware: TesserAPI's test firmware, the demo, and the ported helionext motors page. They are shared by both renderers' tests.
2. **Model tests** (vitest): inference (§4), hints (§5), conditions, formatting and layout decisions produce the expected UI model for each fixture.
3. **Store tests** (vitest): merge patches, pending writes and their reconciliation, overflow, reconnect and forms, against a fake client.
4. **Golden models:** `fixtures/<name>.model.json`, the UI model the web renderer's model gives for each fixture (the page, and the views). They are the expected output of every renderer's model, LVGL's included: renderers share the fixtures' inputs and these outputs. Rewritten deliberately (`vitest -u`), checked in CI.
5. **Web end-to-end** (Playwright): the bundle against the TesserAPI test firmware on hardware, self-hosted and through a UI host. Each widget type gets a scripted interaction, checked against the device's read-back value. The suite also measures the bundle size, a first render under 1 s on a mid-range phone, and the write round trip.
6. **Host node:** `test/` builds `tesserui_demo`, the demo tree on real TesserAPI over `LineTransport`s on stdin/stdout, with live values, events, a deferred action, file nodes (`/system/backup`, and the heliostat peer's `/diagnostics/log`, relayed), and peers behind an in-memory link through TesserAPI's real forwarding. `web/scripts/device.mjs` serves it as a self-hosted node does (page, bundle, HTTP with streamed subscriptions and raw file transfers, which it moves in envelopes, WebSocket), shared by every client, or with one fresh node per connection for the end-to-end tests (Playwright, `web/e2e`).
7. **LVGL:** the renderer is built for the host with LVGL's SDL driver and screenshot-tested against the fixtures. On-target tests then check memory per page and that no heap is lost across page changes.
8. **CI:** web tests, bundle-size budget, LVGL host build and screenshots, plus ESP-IDF and Arduino builds of the examples, as in TesserAPI.

## 12. Packaging

```
TesserUI/
  docs/DESIGN.md
  web/                 the web renderer (npm package "tesserui": dist/ui.js for nodes, tesserui.js and its types for applications, dist/launcher.js, index.html and dist/flash/ for launchers, §9.7)
  web/pages/           the launcher's page on GitHub Pages, with the firmware it installs
  bridge/              tesserui-bridge (npm): mDNS discovery, proxies and serial ports on localhost, for the launcher (§9.7)
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
| Coalescing per forwarded subscriber (`interval` is the first subscriber's) | Slow clients behind a UI host. | Pages ask for 100 ms everywhere. |
| Deferred actions without an argument shouldn't report `arg: "any"` | Tell a deferred action that takes no argument from one taking raw JSON. | Deferred `arg: "any"` actions are buttons (§4); typed deferred actions report their type. |

## 14. Roadmap

| Phase | Content | Acceptance | Status |
|---|---|---|---|
| 1 | UI model (§4, §5), web client and store, widgets for every tier 0 type, self-hosted serving | The TesserAPI test firmware is fully usable from a phone; bundle within the budget of §2. | implemented; checked on hardware: the test firmware driven from a browser (WebSocket and HTTP), and `WebUi` serving the bundle from a chip's flash (ETag, 304). Token authentication works over WebSocket and HTTP. |
| 2 | UI host: `/peers` links, peer pages through the gateway, offline handling, stub serving, Web Serial | A NowTP-only node is controlled from a browser through a UI host, with live values. | implemented; peer pages and forwarded subscriptions checked through the test firmware's gateway over ESP-NOW. The USB gateway (`UsbGateway`) checked on hardware from a serial script: a peer mounted over ESP-NOW, read, written, and its change notifications forwarded down the serial line. Built but not yet run on hardware: the UI host and NowTP-only node examples, stub serving (host-tested), Web Serial from a browser (tested end to end with a fake port). |
| 3 | LVGL renderer: pages, widget mapping, `LocalClient` and `PeerClient` | The same node on a 320×240 touchscreen, locally and from a remote handheld. | not started |
| 4 | Views (§8), charts, forms, conditions | helionext's motors and calibration pages, ported with no hand-written UI: `describe()` plus hints. | implemented; the motors fixture renders without UI code, and views, charts, forms and conditions pass end-to-end tests against the host demo device |
| 5 | Monochrome profile, color widget, custom pages *(later)* | | web: color widget, custom elements and pages (§9.8), embedding (§9.9), interface text (§9.10) |
| 6 | Launcher (§9.7): GitHub Pages, USB, Bluetooth and network ways, a NowTP gateway on USB | Any node reachable from a published page, with no UI assets on it. | implemented; the launcher's ways tested end to end against the host node (USB and Bluetooth through fakes cutting lines into pieces among log output). On hardware: the USB gateway driven over serial, mounting a peer over ESP-NOW with live notifications; the Bluetooth example driven from Chrome's Web Bluetooth and from a Mac (`bleak`); the ESP-IDF Bluetooth and USB gateway examples likewise. The network way from an HTTPS origin in Chrome, local network access granted: the test firmware polled over HTTP (CORS), the mixed content allowed with a console warning. Files in envelopes over a line: tested end to end against the host node through the USB and Bluetooth fakes; on hardware, 20 KB up and back through the bridge's serial port to the test firmware, at 7 to 8 KB/s, and through the test firmware's gateway to its peer over ESP-NOW in WebSocket envelopes (20 KB up in 1.3 s, down in 0.7 s, the page live throughout). Installing firmware (§9.7.1): end to end up to the port chooser (the flasher loaded only on demand, versions from a manifest, a file); on hardware, TesserKIT v0.1.12 `full` installed on an ESP32 devkit by the flasher in headless Chromium (its Web Serial relayed to the port, DTR and RTS included), Wi-Fi joined through TesserKIT's service in 20 s, then the device's page over the same line. The workspace (§9.7.2): end to end against the host node, two connections at once with one tab per device and a change applied across them, network and USB connections opened again on the next visit, the bridge's nodes joining as tabs. On hardware (2026-10-13), through the bridge's mDNS: two devkits on TesserKIT 27e8589 (TesserAPI b852626), each mounting the other over NowTP, and ballet-photophonique's Gledopto, its own firmware without a root id. The devkits are a tab each, each hiding the other's stub by id. The Gledopto shows twice, directly and through a devkit, having no id. A brightness applied to all from one devkit reached the other (✓, read back), was absent on the Gledopto both ways, and wasn't sent to two offline peers, as the toast said. |

## 15. Decisions

- **Hints live in TesserAPI's schema, not in a separate UI file.** One declaration per field, and they reach every renderer through every transport. TesserAPI only stores them (§7.1 of TesserAPI), so it stays UI-agnostic.
- **Renderers don't share code.** A shared C core compiled to WebAssembly would cost more bundle than the TypeScript it replaces. Consistency comes from the shared fixtures (§11).
- **Svelte rather than Preact or Lit:** compiled output, signals-based reactivity, and the stack `small-webui` and helionext already use. The deciding rule is the bundle budget (§2). If the budget is at risk, reconsider.
- **Custom elements for custom widgets and pages:** a web standard any framework can produce, isolated in its shadow root, loaded only where used, and costing the bundle under 1 KB. A plugin API of TesserUI's own would tie extensions to Svelte and to TesserUI's internals.
- **No device-side history for charts.** A renderer keeps history while it watches. Devices that need logged history expose it as a list or a custom node.
