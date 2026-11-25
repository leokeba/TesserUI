// A remote controller for the TesserAPI nodes around it (docs/DESIGN.md
// sections 3.1 and 10): a touchscreen board that hears nodes over ESP-NOW
// (NowTP), lists them, and opens any of them on its screen, with live
// values. No UI code on either side: the nodes describe themselves.
//
// The board is a NowTP gateway: TesserAPI mounts every node it discovers
// under /peers and forwards reads, writes and subscriptions to it (TesserAPI
// section 14), and the LVGL renderer shows that tree through a LocalClient.
// "Nodes" in the menu lists them, a green dot for those heard lately; one
// opens on its own menu.
//
// Channel: ESP-NOW nodes only hear each other on one channel. Nodes on a
// Wi-Fi network use their router's. In auto (This remote > Channel), the
// remote listens on every channel and settles on the busiest (NowTP's
// channel following, ChannelPick::Busiest), follows it if the router moves,
// and keeps the channel it used, to start there next time: a restart comes
// back to the same nodes. A fixed channel stays put. "Scan channels" lists
// what each channel hears; "Use this channel" on one fixes it.
//
// Security: if the nodes share a NowTP installation key, open "Let a node
// join" on one of them (TesserKIT: NowTP > Pairing), then "Join" here
// (This remote > Pairing). The key is kept in NVS.
//
// Accounts: a node with accounts (TesserKIT's) shows what this remote's
// level allows; "Sign in" in the header signs in to it, and the remote
// presents the token to it from then on (RemoteNode::setToken()).
//
// Boards (../components): the "cheap yellow display" with two USB ports,
// by touch (cyd, the default), or the LilyGO T-Display, by its two buttons
// (idf.py -DBOARD=tdisplay): GPIO 35 moves between controls, GPIO 0
// presses or edits one, held it goes back. The console's UART carries API
// envelopes too.
#include <stdio.h>
#include <stdlib.h>

#include <string>
#include <vector>

#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"

#include "NowTP.h"
#include "TesserAPI.h"
#include "TesserUI.h"
#include "board.h"

namespace {

tesser::Api api;
tesser::UartTransport serialApi(api, UART_NUM_0);
nowtp::EspNowTransport radio;
tesser::NowTpTransport nowApi(&api, radio);

int backlight = 80;
board::Orientation orientation = board::Orientation::Landscape;  // set by the API, applied by the UI loop
tesser::NvsStorage storage("remote");
std::string pairing = "idle";  // guarded by the API lock
bool pairingBusy = false;

uint32_t now() { return static_cast<uint32_t>(esp_timer_get_time() / 1000); }

// pair() blocks until a node with an open pairing window answers: in a task
// of its own, so the screen stays live.
void pairTask(void*) {
    nowtp::Status s = radio.pair(60000);
    {
        tesser::Lock lock(api);
        pairing = s == nowtp::Status::Ok ? "joined" : std::string("failed: ") + nowtp::toString(s);
        pairingBusy = false;
    }
    vTaskDelete(nullptr);
}

tesser::Object* peersObject = nullptr;

// The channel setting: auto, or 1-13 fixed. Applied by the UI loop.
enum class ChannelChoice : uint8_t { Auto = 0 };  // 1-13: that channel
const char* const kChannelNames[] = {"auto", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13"};
ChannelChoice channelChoice = ChannelChoice::Auto;
int lastChannel = 0;  // in auto, the channel used last (0: none yet), tried first at boot

uint8_t fixedChannel() { return static_cast<uint8_t>(channelChoice); }

// What the last sweep heard, a row per channel (guarded by the API lock).
struct ChannelRow {
    uint8_t channel = 0;
    std::string name;   // "Channel 6"
    std::string heard;  // the nodes' names
    int nodes = 0;
    int anchors = 0;
};
std::vector<ChannelRow> channelRows;
tesser::ListNode* channelList = nullptr;

void fillRows(const nowtp::ChannelSweep& sweep) {
    std::vector<ChannelRow> rows;
    for (const nowtp::SweptNode& n : sweep.nodes) {
        ChannelRow* row = nullptr;
        for (ChannelRow& r : rows) {
            if (r.channel == n.channel) row = &r;
        }
        if (!row) {
            size_t at = 0;
            while (at < rows.size() && rows[at].channel < n.channel) at++;
            row = &*rows.insert(rows.begin() + static_cast<std::ptrdiff_t>(at), ChannelRow());
            row->channel = n.channel;
            row->name = "Channel " + std::to_string(n.channel);
        }
        if (!row->heard.empty()) row->heard += ", ";
        if (n.name[0]) {
            row->heard += n.name;
        } else {
            const uint8_t* b = n.mac.bytes;
            char mac[13];
            snprintf(mac, sizeof mac, "%02x%02x%02x%02x%02x%02x", b[0], b[1], b[2], b[3], b[4], b[5]);
            row->heard += mac;
        }
        row->nodes++;
        if (n.anchor) row->anchors++;
    }
    tesser::Lock lock(api);
    channelRows.swap(rows);
    channelList->changed();
}

// "c8c9a3c7f850" -> its six bytes.
bool parseDevice(const std::string& id, tesser::PeerAddress& out) {
    if (id.size() != 12) return false;
    uint8_t b[6];
    for (int i = 0; i < 6; i++) {
        char hex[3] = {id[2 * i], id[2 * i + 1], 0};
        char* end = nullptr;
        b[i] = static_cast<uint8_t>(strtoul(hex, &end, 16));
        if (end != hex + 2) return false;
    }
    out = tesser::PeerAddress::fromBytes(b, 6);
    return true;
}

void buildTree() {
    api.label("Remote");
    // Discovered nodes are mounted here as they are heard, and shown offline
    // when lost.
    auto& peers = api.object("peers").label("Nodes").ui("icon", "radio");
    peersObject = &peers;

    auto& self = api.object("remote").label("This remote").ui("icon", "settings");
    self.value("backlight", backlight).range(10, 100).step(5).unit("%").persist();
    // Applied by the UI loop: a write over the console comes from its task.
    self.value("orientation", orientation, {"landscape", "portrait", "landscape-flipped", "portrait-flipped"})
        .ui("labels", "Landscape,Portrait,Landscape (turned),Portrait (turned)")
        .persist();
    self.value("channel", channelChoice, kChannelNames)
        .label("Channel")
        .ui("labels", "Auto (busiest),1,2,3,4,5,6,7,8,9,10,11,12,13")
        .persist();
    self.value("current", [] { return radio.channel(); }).label("Channel in use").watch();
    self.value("lastChannel", lastChannel).range(0, 13).persist().ui("hidden");

    auto& scan = self.object("scan").label("Scan channels");
    scan.action("start",
                [] {
                    nowtp::Status st = radio.sweepChannels();
                    return st == nowtp::Status::Ok         ? tesser::Status::Ok
                           : st == nowtp::Status::NoMemory ? tesser::Status::Busy
                                                           : tesser::Status::NotAllowed;
                })
        .label("Scan");
    scan.value("scanning", [] { return radio.sweepingChannels(); }).label("Scanning").watch();
    channelList = &scan.list("channels", channelRows, [](tesser::Object& o, ChannelRow& r) {
                          o.value("name", r.name).label("Channel");
                          o.value("heard", r.heard).label("Nodes heard");
                          o.value("nodes", r.nodes).label("Nodes");
                          o.value("anchors", r.anchors).label("Anchors");
                          uint8_t ch = r.channel;
                          o.action("use",
                                   [ch] {
                                       channelChoice = static_cast<ChannelChoice>(ch);
                                       api.changed("/remote/channel");
                                   })
                              .label("Use this channel");
                      })
                       .readOnly()
                       .label("Heard");
    self.value("heap", [] { return esp_get_free_heap_size(); }).unit("B").watch();
    self.value("minHeap", [] { return esp_get_minimum_free_heap_size(); }).unit("B").label("Lowest heap").watch();

    auto& sec = self.object("pairing").label("Pairing");
    sec.value("secured", [] { return radio.secured(); }).label("Paired").watch();
    sec.value("state", static_cast<const std::string&>(pairing)).label("Pairing");
    sec.action("join",
               [] {
                   if (pairingBusy) return;
                   pairingBusy = true;
                   pairing = "waiting for a node (60 s)";
                   xTaskCreate(pairTask, "pair", 4096, nullptr, 4, nullptr);
               })
        .label("Join")
        .ui("confirm", "Open \"Let a node join\" on a node of the installation first.");
    sec.action("forget",
               [] {
                   radio.forgetSecurityKey();
                   pairing = "forgotten";
               })
        .label("Forget the key")
        .ui("style", "danger")
        .ui("confirm", "Forget the installation key? Nodes that require it won't answer any more.");

    nowApi.mountPeers(peers);
}

}  // namespace

extern "C" void app_main() {
    esp_err_t err = nvs_flash_init();  // Wi-Fi's calibration, NowTP's key
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
    buildTree();
    api.persistence(storage);  // the backlight and the orientation, in NVS
    api.load();

    lv_init();
    board::Orientation shown = orientation;
    lv_display_t* display = board::begin(shown);
    int lit = backlight;
    board::backlight(static_cast<uint8_t>(lit));
    board::led(0, 0, 0);

    nowtp::EspNowConfig cfg;
    cfg.enableDiscovery = true;
    cfg.discovery.name = "lcd-remote";
    cfg.channel.findAnchor = true;  // search every channel for the nodes' network
    cfg.channel.pick = nowtp::ChannelPick::Busiest;
    // Start where we were (no sweep if nodes answer there), or sweep.
    ChannelChoice applied = channelChoice;
    cfg.channel.preferred = fixedChannel() ? fixedChannel() : static_cast<uint8_t>(lastChannel);
    radio.onPeerEvent([](nowtp::PeerEvent e, const nowtp::PeerInfo& p) { nowApi.peerEvent(e, p); });
    ESP_ERROR_CHECK(radio.begin(cfg) == nowtp::Status::Ok ? ESP_OK : ESP_FAIL);  // starts Wi-Fi itself
    if (fixedChannel()) radio.pinChannel(fixedChannel());
    nowApi.begin();

    tesser::LocalClient client(api);
    tesserui::LvglUi ui(client, display);
    if (lv_indev_t* buttons = board::buttons()) ui.input(buttons);  // no touchscreen
    // Signed in to a node: the gateway presents the token to it.
    ui.onSignIn([](const std::string&, const std::string& device, const std::string& token) {
        tesser::PeerAddress address;
        if (!parseDevice(device, address)) return;
        tesser::Lock lock(api);
        if (tesser::RemoteNode* node = tesser::RemoteNode::byDevice(*peersObject, address)) node->setToken(token);
    });
    ui.begin("/");
    ESP_ERROR_CHECK(serialApi.begin());  // requests over the console, in its own task

    uint32_t sweepCheck = 0;
    uint32_t shownSweep = 0;  // the sequence of the sweep the rows show
    bool wasSweeping = false;
    // Without a channel to start on, NowTP sweeps first: keep the channel
    // only once a sweep ended, or a restart meanwhile would stay on channel 1.
    bool settled = cfg.channel.preferred != 0;
    for (;;) {
        if (orientation != shown) board::orientation(shown = orientation);
        if (channelChoice != applied) {
            applied = channelChoice;
            if (fixedChannel()) {
                radio.pinChannel(fixedChannel());
            } else {
                radio.followChannels();
            }
        }
        if (now() - sweepCheck >= 500) {
            sweepCheck = now();
            // The scan's rows, while a sweep fills them and once after (the
            // boot sweep may have ended before the first look).
            bool sweeping = radio.sweepingChannels();
            if (sweeping || wasSweeping || shownSweep == 0) {
                nowtp::ChannelSweep sweep = radio.channelSweep();
                if (sweep.sequence != 0) {
                    fillRows(sweep);
                    shownSweep = sweep.sequence;
                    if (!sweep.running) settled = true;
                }
            }
            wasSweeping = sweeping;
            // In auto, the channel settled on, to start there next time.
            int ch = radio.channel();
            if (settled && !fixedChannel() && ch != lastChannel && !radio.searchingChannels()) {
                tesser::Lock lock(api);
                lastChannel = ch;
                api.changed("/remote/lastChannel");  // saved
            }
        }
        if (board::backPressed()) ui.escape();
        if (backlight != lit) board::backlight(static_cast<uint8_t>(lit = backlight));
        api.poll(now());  // forwarded notifications, watched values, saving settings
        ui.loop();
        lv_timer_handler();
        vTaskDelay(pdMS_TO_TICKS(5) ? pdMS_TO_TICKS(5) : 1);  // at least a tick: the idle task must run
    }
}
