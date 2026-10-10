// Schema fixtures (docs/DESIGN.md section 11): builds trees with the real
// TesserAPI and writes what a renderer would read from them, shared by the
// web and LVGL renderers' tests.
//
//   ./tesserui_fixtures [directory]      (default: fixtures)
//
// Each file is {"source": ..., "schema": <GET /?view=schema>, "values":
// <GET />, "views": <GET /_ui, when the tree has views>}, with TesserAPI's
// JSON text kept verbatim. The trees (trees.h) are the ones tesserui_demo
// serves, before any tick(), so the output is reproducible.
#include <errno.h>
#include <stdio.h>
#include <sys/stat.h>

#include <string>
#include <vector>

#include "TesserAPI.h"
#include "trees.h"

namespace {

std::string read(tesser::Api& api, const char* path, tesser::View view) {
    tesser::Request req;
    req.op = tesser::Op::Get;
    req.path = path;
    req.query.view = view;
    tesser::StringReply reply;
    api.handle(req, reply);
    if (reply.status != tesser::Status::Ok) {
        fprintf(stderr, "GET %s failed: %s\n", path, reply.body.c_str());
        return "null";
    }
    return reply.body;
}

bool writeFixture(const std::string& dir, const char* name, const char* source, tesser::Api& api) {
    std::string out = "{\"source\":";
    {
        tesser::StringSink sink(out);
        tesser::JsonWriter w(sink);
        w.string(source);
    }
    out += ",\"schema\":" + read(api, "/", tesser::View::Schema);
    out += ",\"values\":" + read(api, "/", tesser::View::Value);
    if (api.child("_ui")) out += ",\"views\":" + read(api, "/_ui", tesser::View::Value);
    out += "}\n";

    std::string path = dir + "/" + name;
    FILE* f = fopen(path.c_str(), "w");
    if (!f) {
        fprintf(stderr, "cannot write %s\n", path.c_str());
        return false;
    }
    bool ok = fwrite(out.data(), 1, out.size(), f) == out.size();
    ok = fclose(f) == 0 && ok;
    printf("%s: %zu bytes\n", path.c_str(), out.size());
    return ok;
}

}  // namespace

int main(int argc, char** argv) {
    std::string dir = argc > 1 ? argv[1] : "fixtures";
    if (mkdir(dir.c_str(), 0755) != 0 && errno != EEXIST) {
        fprintf(stderr, "cannot create %s\n", dir.c_str());
        return 1;
    }
    bool ok = true;
    {
        trees::Demo d;
        ok = writeFixture(dir, "demo.json",
                          "TesserUI test/fixtures_main.cpp: demo, every widget and hint of docs/DESIGN.md "
                          "sections 4 and 5",
                          d.api) &&
             ok;
    }
    {
        trees::Motors m;
        ok = writeFixture(dir, "motors.json",
                          "TesserUI test/fixtures_main.cpp: motors, helionext's motors page ported to describe() "
                          "and hints",
                          m.api) &&
             ok;
    }
    if (tesser::declarationErrors() != 0) {
        fprintf(stderr, "%d declaration error(s)\n", tesser::declarationErrors());
        ok = false;
    }
    return ok ? 0 : 1;
}
