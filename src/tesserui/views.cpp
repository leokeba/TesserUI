#include "tesserui/views.h"

#include <string.h>

namespace tesserui {

namespace detail {

// An extra key on an item's object.
struct Hint {
    enum class Kind : uint8_t { String, Number, Bool };
    const char* key;
    union {
        const char* str;
        double num;
        bool flag;
    };
    Kind kind;
    Hint* next = nullptr;
};

// One view item. The meaning of a, b and c depends on the kind:
//   Node    a: path
//   Widget  a: widget, b: path, c: label (optional)
//   Text    a: text
//   Each    a: object path, b: the repeated node's path
//   Row     box: the items
//   Card    a: label, box: the items
struct Item {
    enum class Kind : uint8_t { Node, Widget, Text, Each, Row, Card };
    explicit Item(Kind k) : kind(k) {}
    ~Item() {
        delete box;
        while (hints) {
            Hint* h = hints;
            hints = h->next;
            delete h;
        }
    }
    Item(const Item&) = delete;
    Item& operator=(const Item&) = delete;

    Kind kind;
    const char* a = nullptr;
    const char* b = nullptr;
    const char* c = nullptr;
    Hint* hints = nullptr;
    Container* box = nullptr;
    Item* next = nullptr;
};

struct ViewsState {
    ~ViewsState() {
        while (first) {
            Page* p = first;
            first = p->next_;
            delete p;
        }
    }
    Page* find(const char* id) const {
        for (Page* p = first; p; p = p->next_) {
            if (p->id_ == id || (p->id_ && id && strcmp(p->id_, id) == 0)) return p;
        }
        return nullptr;
    }
    Page& add(const char* id, const char* label) {
        Page* p = new Page(id, label);
        if (last) {
            last->next_ = p;
        } else {
            first = p;
        }
        last = p;
        return *p;
    }
    void write(tesser::JsonWriter& w) const {
        w.beginObject();
        w.key("pages");
        w.beginArray();
        for (const Page* p = first; p; p = p->next_) {
            w.beginObject();
            w.key("id");
            if (p->id_) {
                w.string(p->id_);
            } else {
                w.null();
            }
            if (p->label_) {
                w.key("label");
                w.string(p->label_);
            }
            w.key("items");
            p->writeItems(w);
            w.endObject();
        }
        w.endArray();
        w.endObject();
    }

    Page* first = nullptr;
    Page* last = nullptr;
};

namespace {

// A string that may be null.
void writeString(tesser::JsonWriter& w, const char* s) {
    if (s) {
        w.string(s);
    } else {
        w.null();
    }
}

void writeHints(tesser::JsonWriter& w, const Hint* h) {
    for (; h; h = h->next) {
        if (!h->key) continue;
        w.key(h->key);
        switch (h->kind) {
            case Hint::Kind::String: writeString(w, h->str); break;
            case Hint::Kind::Number: w.number(h->num); break;
            case Hint::Kind::Bool: w.boolean(h->flag); break;
        }
    }
}

void writeItem(tesser::JsonWriter& w, const Item& item) {
    w.beginObject();
    switch (item.kind) {
        case Item::Kind::Node:
            w.key("node");
            writeString(w, item.a);
            break;
        case Item::Kind::Widget:
            w.key("widget");
            writeString(w, item.a);
            w.key("path");
            writeString(w, item.b);
            if (item.c) {
                w.key("label");
                w.string(item.c);
            }
            break;
        case Item::Kind::Text:
            w.key("text");
            writeString(w, item.a);
            break;
        case Item::Kind::Each:
            // The hints belong to the repeated item, which is what they
            // describe.
            w.key("each");
            writeString(w, item.a);
            w.key("item");
            w.beginObject();
            w.key("node");
            writeString(w, item.b);
            writeHints(w, item.hints);
            w.endObject();
            w.endObject();
            return;
        case Item::Kind::Row:
            w.key("row");
            item.box->writeItems(w);
            break;
        case Item::Kind::Card:
            w.key("card");
            w.string(item.a ? item.a : "");  // untitled card
            w.key("items");
            item.box->writeItems(w);
            break;
    }
    writeHints(w, item.hints);
    w.endObject();
}

}  // namespace

}  // namespace detail

using detail::Hint;
using detail::Item;

// ---- Container ---------------------------------------------------------

Container::~Container() {
    while (first_) {
        Item* item = first_;
        first_ = item->next;
        delete item;
    }
}

Item& Container::add(Item* item) {
    if (last_) {
        last_->next = item;
    } else {
        first_ = item;
    }
    last_ = item;
    return *item;
}

Container& Container::node(const char* path) {
    add(new Item(Item::Kind::Node)).a = path;
    return *this;
}

Container& Container::widget(const char* widget, const char* path, const char* label) {
    Item& item = add(new Item(Item::Kind::Widget));
    item.a = widget;
    item.b = path;
    item.c = label;
    return *this;
}

Container& Container::text(const char* s) {
    add(new Item(Item::Kind::Text)).a = s;
    return *this;
}

Container& Container::each(const char* path, const char* nodePath) {
    Item& item = add(new Item(Item::Kind::Each));
    item.a = path;
    item.b = nodePath;
    return *this;
}

Container& Container::row() {
    Item& item = add(new Item(Item::Kind::Row));
    item.box = new Container();
    return *item.box;
}

Container& Container::card(const char* label) {
    Item& item = add(new Item(Item::Kind::Card));
    item.a = label;
    item.box = new Container();
    return *item.box;
}

namespace {

// The last item's hint for `key`, created at the end of its list if needed.
// Null when there is no item.
Hint* editHint(Item* item, const char* key) {
    if (!item || !key) return nullptr;
    Hint** link = &item->hints;
    for (; *link; link = &(*link)->next) {
        if (strcmp((*link)->key, key) == 0) return *link;
    }
    *link = new Hint();
    (*link)->key = key;
    return *link;
}

}  // namespace

Container& Container::hint(const char* key, const char* value) {
    if (Hint* h = editHint(last_, key)) {
        h->kind = Hint::Kind::String;
        h->str = value;
    }
    return *this;
}

Container& Container::hint(const char* key, bool value) {
    if (Hint* h = editHint(last_, key)) {
        h->kind = Hint::Kind::Bool;
        h->flag = value;
    }
    return *this;
}

Container& Container::numberHint(const char* key, double value) {
    if (Hint* h = editHint(last_, key)) {
        h->kind = Hint::Kind::Number;
        h->num = value;
    }
    return *this;
}

size_t Container::size() const {
    size_t n = 0;
    for (const Item* item = first_; item; item = item->next) n++;
    return n;
}

void Container::writeItems(tesser::JsonWriter& w) const {
    w.beginArray();
    for (const Item* item = first_; item; item = item->next) detail::writeItem(w, *item);
    w.endArray();
}

// ---- Views -------------------------------------------------------------

Views::Views(tesser::Object& root) : state_(std::make_shared<detail::ViewsState>()) {
    // The node shares the declaration, so it outlives this object.
    std::shared_ptr<const detail::ViewsState> state = state_;
    node_ = &root.custom("_ui", [state](tesser::JsonWriter& w) { state->write(w); })
                 .label("Views")
                 .ui("hidden");
}

Page& Views::page(const char* id, const char* label) {
    if (Page* p = state_->find(id)) return *p;
    return state_->add(id, label);
}

void Views::write(tesser::JsonWriter& w) const { state_->write(w); }

}  // namespace tesserui
