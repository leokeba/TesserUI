// The LVGL renderer on the host, driving the demo tree (trees.h) through a
// LocalClient as firmware would its own.
//
//   ./tesserui_lcd [demo|motors]              a 320x240 window (SDL2), live values
//   ./tesserui_lcd [demo|motors] --shots DIR [--width N] [--height N] [--encoder] [path...]
//                                             screenshots: the menu, then each
//                                             path's page (default: every entry)
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <algorithm>
#include <memory>
#include <string>
#include <vector>

#include "TesserAPI.h"
#include "lcd_host.h"
#include "tesserui/lvgl_ui.h"
#include "tesserui/model.h"
#include "trees.h"

namespace {

std::string shotName(const std::string& path) {
    if (path.empty()) return "menu";
    std::string out;
    for (char c : path.substr(1)) out += c == '/' ? '_' : c;
    return out.empty() ? "status" : out;
}

}  // namespace

int main(int argc, char** argv) {
    const char* which = "demo";
    const char* shots = nullptr;
    int32_t width = 320;
    bool encoder = false;  // buttons instead of touch: the focus shows
    int32_t height = 240;  // taller screenshots show whole pages; 240x320 is portrait
    std::vector<std::string> paths;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--shots") == 0 && i + 1 < argc) {
            shots = argv[++i];
        } else if (strcmp(argv[i], "--encoder") == 0) {
            encoder = true;
        } else if (strcmp(argv[i], "--width") == 0 && i + 1 < argc) {
            width = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--height") == 0 && i + 1 < argc) {
            height = atoi(argv[++i]);
        } else if (argv[i][0] == '/') {
            paths.push_back(argv[i]);
        } else {
            which = argv[i];
        }
    }
    std::unique_ptr<trees::Demo> demo;
    std::unique_ptr<trees::Motors> motors;
    tesser::Api* api = nullptr;
    if (strcmp(which, "motors") == 0) {
        motors.reset(new trees::Motors());
        api = &motors->api;
    } else {
        demo.reset(new trees::Demo());
        api = &demo->api;
    }
    lv_init();
    tesser::LocalClient client(*api);

    if (shots) {
        lcd::Screen screen(width, height);
        tesserui::LvglUi ui(client, screen.display());
        if (encoder) ui.input(screen.encoder());
        auto each = [&] {
            if (demo) demo->pump(trees::clockMs());
            ui.loop();
        };
        ui.begin("/");
        screen.run(300, each);
        if (paths.empty()) {
            // Every entry of the menu, and their sub-entries.
            tesser::LocalClient reader(*api);
            tesser::Query q;
            q.view = tesser::View::Schema;
            q.depth = 2;
            reader.get("/", [&](tesser::Status, JsonVariantConst body) {
                for (const auto& e : tesserui::model::buildMenu(body, "/")) {
                    if (!e.path.empty()) paths.push_back(e.path);
                    for (const auto& c : e.children) paths.push_back(c.path);
                }
            }, q);
            reader.process();
        }
        int failed = 0;
        std::string dir = shots;
        if (!screen.png(dir + "/menu.png")) failed++;
        for (const std::string& p : paths) {
            ui.open(p, tesserui::model::isUnder(p, "/peers") && std::count(p.begin(), p.end(), '/') == 2 ? p : "");
            screen.run(400, each);
            if (!screen.png(dir + "/" + shotName(p) + ".png")) failed++;
            ui.back();
            screen.run(100, each);
        }
        printf("%zu screenshots in %s\n", paths.size() + 1, shots);
        return failed ? 1 : 0;
    }

#if LV_USE_SDL
    lv_display_t* display = lv_sdl_window_create(320, 240);
    lv_sdl_window_set_zoom(display, 2);
    lv_sdl_window_set_title(display, "TesserUI");
    lv_sdl_mouse_create();
    lv_tick_set_cb(trees::clockMs);
    tesserui::LvglUi ui(client, display);
    ui.begin("/");
    for (;;) {
        uint32_t now = trees::clockMs();
        if (demo) {
            demo->tick(now);
            demo->pump(now);
        }
        ui.loop();
        uint32_t next = lv_timer_handler();
        if (next > 5) next = 5;
        lv_delay_ms(next);
    }
#else
    fprintf(stderr, "built without SDL2: only --shots DIR works\n");
    return 2;
#endif
}
