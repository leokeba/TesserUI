// A live demo node on stdin/stdout, for testing renderers against real
// TesserAPI semantics: one JSON envelope per line in, responses and
// notifications out (TesserAPI's LineTransport). Logs go to stderr, so stdout
// carries only envelope lines. Exits at the end of input.
//
//   ./tesserui_demo [demo|motors] [--clients]   (default: demo)
//   printf '{"id":1,"op":"get","path":"/lamp"}\n' | ./tesserui_demo
//
// With --clients, several clients share the node, as browsers share a real
// one: each line in is "<client> <envelope>", each line out "<client> <line>",
// and each client has its own LineTransport (its own subscriptions).
// "<client> close" drops one.
//
// The trees are the fixtures' (trees.h). The demo tree is animated (uptime,
// sensors, the motor's position, an event every 5 s, a deferred action), and
// its /peers/heliostat-3 and /peers/porch-lamp are live trees behind an
// in-memory link, reached through TesserAPI's forwarding as over NowTP.
#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <map>
#include <memory>
#include <string>

#include "TesserAPI.h"
#include "trees.h"

namespace {

// One client of the shared node: its LineTransport, and its output prefixed
// with its id, a whole line at a time.
struct Client {
    Client(tesser::Api& api, long id)
        : prefix(std::to_string(id) + " "), line(api, [this](const char* data, size_t len) {
              out.append(data, len);
              size_t nl;
              while ((nl = out.find('\n')) != std::string::npos) {
                  fwrite(prefix.data(), 1, prefix.size(), stdout);
                  fwrite(out.data(), 1, nl + 1, stdout);
                  out.erase(0, nl + 1);
              }
              fflush(stdout);
          }) {}
    std::string prefix;
    std::string out;
    tesser::LineTransport line;
};

}  // namespace

int main(int argc, char** argv) {
    bool clients = false;
    const char* which = "demo";
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--clients") == 0) {
            clients = true;
        } else {
            which = argv[i];
        }
    }
    std::unique_ptr<trees::Demo> demo;
    std::unique_ptr<trees::Motors> motors;
    tesser::Api* api = nullptr;
    if (strcmp(which, "demo") == 0) {
        demo.reset(new trees::Demo());
        api = &demo->api;
    } else if (strcmp(which, "motors") == 0) {
        motors.reset(new trees::Motors());
        api = &motors->api;
    } else {
        fprintf(stderr, "usage: %s [demo|motors] [--clients]\n", argv[0]);
        return 2;
    }

    tesser::LineTransport line(*api, [](const char* data, size_t len) {
        fwrite(data, 1, len, stdout);
        fflush(stdout);
    });
    fprintf(stderr, "tesserui_demo: serving \"%s\" on stdin/stdout%s\n", which, clients ? " to several clients" : "");

    std::map<long, std::unique_ptr<Client>> byId;
    std::string pending;  // --clients: input up to the next newline
    auto dispatch = [&](const std::string& in) {
        char* rest = nullptr;
        long id = strtol(in.c_str(), &rest, 10);
        if (rest == in.c_str() || *rest != ' ') return;
        std::string body(rest + 1);
        if (body == "close") {
            byId.erase(id);  // destroying the transport drops its subscriptions
            return;
        }
        auto& c = byId[id];
        if (!c) c.reset(new Client(*api, id));
        body += '\n';
        c->line.feed(body.data(), body.size());
    };

    char buf[4096];
    for (;;) {
        struct pollfd pfd = {0, POLLIN, 0};
        int ready = poll(&pfd, 1, 20);
        if (ready < 0 && errno != EINTR) break;
        if (ready > 0) {
            ssize_t n = read(0, buf, sizeof(buf));
            if (n == 0) break;  // end of input
            if (n < 0 && errno != EINTR && errno != EAGAIN) break;
            if (n > 0 && !clients) line.feed(buf, static_cast<size_t>(n));
            if (n > 0 && clients) {
                pending.append(buf, static_cast<size_t>(n));
                size_t nl;
                while ((nl = pending.find('\n')) != std::string::npos) {
                    dispatch(pending.substr(0, nl));
                    pending.erase(0, nl + 1);
                }
            }
        }
        uint32_t now = trees::clockMs();
        if (demo) {
            demo->tick(now);
            demo->pump(now);
        }
        api->poll(now);
    }
    byId.clear();
    api->dropSubscriber(&line);
    return 0;
}
