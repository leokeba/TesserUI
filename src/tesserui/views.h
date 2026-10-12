#pragma once

// Views (docs/DESIGN.md section 8): explicit pages that combine values from
// anywhere in a tree, including several peers, served as the read-only
// custom node /_ui. Platform-independent.

#include <stddef.h>
#include <stdint.h>

#include <memory>
#include <type_traits>

#include "TesserAPI.h"

namespace tesserui {

namespace detail {
struct Item;
struct ViewsState;
}  // namespace detail

// A list of view items: a page, a card or a row. Every string is a literal
// (or outlives the API): it is stored as a pointer, never copied, like
// TesserAPI's node names.
//
// node(), widget(), text(), each() and hint() return this container, so they
// chain; row() and card() return the new child container. References stay
// valid as more items are added.
class Container {
public:
    Container() = default;
    ~Container();
    Container(const Container&) = delete;
    Container& operator=(const Container&) = delete;

    // {"node": path}: the subtree at `path`, rendered by the tier 0 and 1
    // rules.
    Container& node(const char* path);
    // {"widget": widget, "path": path, "label": label}: one widget for one
    // path. `label` is optional.
    Container& widget(const char* widget, const char* path, const char* label = nullptr);
    // {"text": s}: a paragraph. Plain text; **bold** is the only markup.
    Container& text(const char* s);
    // {"each": path, "item": {"node": nodePath}}: the node repeated for each
    // child of the object at `path`, with "$" replaced by the child's path.
    // Hints added after it go on the repeated item.
    Container& each(const char* path, const char* nodePath);
    // {"row": [...]}: items side by side. Returns the row.
    Container& row();
    // {"card": label, "items": [...]}: a card. Returns the card. Hints on
    // the card itself go on its container afterwards, the card being its
    // last item: page.card("Recorder")...; page.hint("wide", true);
    Container& card(const char* label);

    // A hint on the last item added to this container: an extra key on its
    // object, overriding the schema's. Setting a key again replaces it. Does
    // nothing while the container is empty.
    Container& hint(const char* key, const char* value);
    Container& hint(const char* key, bool value);
    template <class T, std::enable_if_t<std::is_arithmetic<T>::value && !std::is_same<T, bool>::value, int> = 0>
    Container& hint(const char* key, T value) {
        return numberHint(key, static_cast<double>(value));
    }

    // Number of items directly in this container.
    size_t size() const;

    // Writes the items as a JSON array.
    void writeItems(tesser::JsonWriter& w) const;

private:
    detail::Item& add(detail::Item* item);
    Container& numberHint(const char* key, double value);

    detail::Item* first_ = nullptr;
    detail::Item* last_ = nullptr;
};

// A view page: {"id": id, "label": label, "icon": icon, "items": [...]}.
// Route #/v/<id>.
class Page : public Container {
public:
    const char* id() const { return id_; }
    const char* label() const { return label_; }
    // Its menu entry's icon, a name from TesserUI's icon set (DESIGN.md §9.3).
    Page& icon(const char* name) {
        icon_ = name;
        return *this;
    }

private:
    friend class Views;
    friend struct detail::ViewsState;
    Page(const char* id, const char* label) : id_(id), label_(label) {}

    const char* id_;
    const char* label_;
    const char* icon_ = nullptr;
    Page* next_ = nullptr;
};

// The view declaration of one API, served as /_ui:
//
//   tesserui::Views views(api);                   // adds the custom node /_ui
//   auto& field = views.page("field", "Field");
//   field.each("/peers", "$/heliostat/status");
//   field.row().widget("gauge", "/sensors/wind").widget("readout", "/sensors/sun/elevation");
//   field.card("Calibration").node("/calib");
//
// The declaration is stored as structures of string literals and rendered on
// request; there is no JSON document at rest. One Views per API (a second one
// would be a duplicate /_ui, reported by tesser::declarationErrors()).
//
// Lifetime: the declaration is shared with the /_ui node, which keeps it for
// as long as the API exists, so a Views may be a local in setup(); pages and
// containers stay valid after it is destroyed. As with the rest of the tree,
// declare views during setup, or hold the API lock (tesser::Lock) when
// transports are already running.
class Views {
public:
    explicit Views(tesser::Object& root);  // usually the tesser::Api
    Views(const Views&) = delete;
    Views& operator=(const Views&) = delete;

    // A page, shown before the node's own tree in the order declared. Returns
    // the existing page when `id` was already declared. `label` is optional:
    // renderers humanize the id without one.
    Page& page(const char* id, const char* label = nullptr);

    // The /_ui custom node, labelled "Views" and hinted "hidden".
    tesser::CustomNode& node() { return *node_; }

    // Writes {"pages": [...]}, the body of GET /_ui.
    void write(tesser::JsonWriter& w) const;

private:
    std::shared_ptr<detail::ViewsState> state_;
    tesser::CustomNode* node_;
};

}  // namespace tesserui
