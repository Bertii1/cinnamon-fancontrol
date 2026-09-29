#!/usr/bin/env python3
#
# Editor grafico delle curve per fancontrol@filippo
#
# - punti trascinabili col mouse
# - doppio clic sulla curva  -> aggiunge un punto
# - clic destro su un punto  -> lo rimuove
# - libreria di curve con nome, salvata in ~/.config/fancontrol/curves.json
# - preset, duplica, rinomina, elimina e "combina" (max / min / media di due curve)
# - riga verticale che segue la temperatura reale della CPU
#
# Avviato dall'applet (voce di menu "Editor curve..."), o a mano:
#   python3 curve-editor.py
#

import os
import sys
import json
import glob

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib, Gdk  # noqa: E402

CURVES_PATH = os.path.expanduser("~/.config/fancontrol/curves.json")

T_MIN, T_MAX = 30.0, 105.0
P_MIN, P_MAX = 0.0, 100.0
MARGIN_L, MARGIN_R, MARGIN_T, MARGIN_B = 52, 22, 22, 42
HIT_RADIUS = 14.0

PRESETS = {
    "Silenzioso": [[45, 0], [50, 5], [55, 10], [60, 16], [65, 22],
                   [70, 30], [75, 38], [80, 48], [85, 60], [90, 75], [95, 100]],
    "Bilanciato": [[45, 0], [50, 8], [55, 15], [60, 22], [65, 30],
                   [70, 38], [75, 47], [80, 57], [85, 70], [90, 84], [95, 100]],
    "Prestazioni": [[40, 10], [45, 18], [50, 27], [55, 36], [60, 45],
                    [65, 55], [70, 65], [75, 78], [80, 90], [85, 100]],
    "Aggressivo": [[35, 20], [40, 30], [45, 42], [50, 55], [55, 68],
                   [60, 80], [65, 92], [70, 100]],
    "Silenzio estremo": [[55, 0], [60, 10], [65, 20], [70, 32], [75, 45],
                         [80, 60], [85, 78], [90, 95], [95, 100]],
}


# --------------------------------------------------------------------- dati

def load_library():
    try:
        with open(CURVES_PATH, "r") as fh:
            data = json.load(fh)
        curves = {k: [[float(a), float(b)] for a, b in v]
                  for k, v in data.get("curves", {}).items() if len(v) >= 2}
        return curves, data.get("active", "Bilanciato")
    except Exception:
        return dict((k, [list(p) for p in v]) for k, v in PRESETS.items()), "Bilanciato"


def save_library(curves, active):
    os.makedirs(os.path.dirname(CURVES_PATH), exist_ok=True)
    tmp = CURVES_PATH + ".tmp"
    with open(tmp, "w") as fh:
        json.dump({"version": 1, "active": active, "curves": curves}, fh, indent=2)
    os.replace(tmp, CURVES_PATH)


def cpu_temperature():
    """Temperatura del package CPU, in °C (o None)."""
    try:
        for base in sorted(glob.glob("/sys/class/hwmon/hwmon*")):
            try:
                name = open(os.path.join(base, "name")).read().strip()
            except Exception:
                continue
            if name not in ("coretemp", "k10temp", "zenpower"):
                continue
            with open(os.path.join(base, "temp1_input")) as fh:
                return int(fh.read().strip()) / 1000.0
    except Exception:
        pass
    return None


def interpolate(points, temp):
    if not points:
        return 0.0
    if temp <= points[0][0]:
        return points[0][1]
    for i in range(1, len(points)):
        a, b = points[i - 1], points[i]
        if temp <= b[0]:
            return a[1] + (b[1] - a[1]) * (temp - a[0]) / (b[0] - a[0])
    return points[-1][1]


# ----------------------------------------------------------------- finestra

class CurveEditor(Gtk.Window):

    def __init__(self):
        super().__init__(title="Editor curve ventola")
        self.set_default_size(760, 560)

        self.curves, self.active = load_library()
        if not self.curves:
            self.curves = dict((k, [list(p) for p in v]) for k, v in PRESETS.items())
        self.name = self.active if self.active in self.curves else sorted(self.curves)[0]
        self.points = [list(p) for p in self.curves[self.name]]
        self.drag = None
        self.temp = cpu_temperature()
        self.dirty = False

        self._build()

        self.connect("destroy", Gtk.main_quit)
        GLib.timeout_add_seconds(1, self._tick)

    # ------------------------------------------------------------- interfaccia

    def _build(self):
        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        outer.set_border_width(10)
        self.add(outer)

        # --- barra superiore
        top = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        outer.pack_start(top, False, False, 0)

        top.pack_start(Gtk.Label(label="Curva:"), False, False, 0)
        self.combo = Gtk.ComboBoxText()
        for k in sorted(self.curves):
            self.combo.append_text(k)
        self.combo.set_active(sorted(self.curves).index(self.name))
        self.combo.connect("changed", self._on_select)
        top.pack_start(self.combo, True, True, 0)

        for label, cb in (("Nuova", self._on_new), ("Duplica", self._on_dup),
                          ("Rinomina", self._on_rename), ("Elimina", self._on_delete)):
            b = Gtk.Button(label=label)
            b.connect("clicked", cb)
            top.pack_start(b, False, False, 0)

        # --- area di disegno
        self.area = Gtk.DrawingArea()
        self.area.set_size_request(700, 400)
        self.area.add_events(Gdk.EventMask.BUTTON_PRESS_MASK |
                             Gdk.EventMask.BUTTON_RELEASE_MASK |
                             Gdk.EventMask.POINTER_MOTION_MASK)
        self.area.connect("draw", self._on_draw)
        self.area.connect("button-press-event", self._on_press)
        self.area.connect("motion-notify-event", self._on_motion)
        self.area.connect("button-release-event", self._on_release)
        outer.pack_start(self.area, True, True, 0)

        # --- barra inferiore
        bottom = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        outer.pack_start(bottom, False, False, 0)

        bottom.pack_start(Gtk.Label(label="Preset:"), False, False, 0)
        for key in PRESETS:
            b = Gtk.Button(label=key)
            b.connect("clicked", lambda _w, k=key: self._apply_preset(k))
            bottom.pack_start(b, False, False, 0)

        b = Gtk.Button(label="Combina…")
        b.connect("clicked", self._on_mix)
        bottom.pack_start(b, False, False, 0)

        self.info = Gtk.Label(label="")
        bottom.pack_start(self.info, True, True, 0)

        b = Gtk.Button(label="Salva")
        b.get_style_context().add_class("suggested-action")
        b.connect("clicked", self._on_save)
        bottom.pack_start(b, False, False, 0)

        b = Gtk.Button(label="Chiudi")
        b.connect("clicked", lambda _w: self.destroy())
        bottom.pack_start(b, False, False, 0)

        self._update_info()

    # ------------------------------------------------------------- geometria

    def _geom(self):
        w = self.area.get_allocated_width()
        h = self.area.get_allocated_height()
        return (w, h,
                MARGIN_L, h - MARGIN_B,
                w - MARGIN_L - MARGIN_R, h - MARGIN_T - MARGIN_B)

    def _to_px(self, temp, pct):
        w, h, x0, y1, gw, gh = self._geom()
        x = x0 + (temp - T_MIN) / (T_MAX - T_MIN) * gw
        y = y1 - (pct - P_MIN) / (P_MAX - P_MIN) * gh
        return x, y

    def _to_data(self, x, y):
        w, h, x0, y1, gw, gh = self._geom()
        temp = T_MIN + (x - x0) / gw * (T_MAX - T_MIN)
        pct = P_MIN + (y1 - y) / gh * (P_MAX - P_MIN)
        return temp, pct

    # ------------------------------------------------------------- disegno

    def _on_draw(self, widget, cr):
        w, h, x0, y1, gw, gh = self._geom()
        style = widget.get_style_context()
        fg = style.get_color(Gtk.StateFlags.NORMAL)

        cr.set_source_rgb(0.09, 0.10, 0.12)
        cr.rectangle(x0, MARGIN_T, gw, gh)
        cr.fill()

        # griglia
        cr.set_line_width(0.6)
        cr.set_source_rgba(fg.red, fg.green, fg.blue, 0.16)
        for t in range(int(T_MIN), int(T_MAX) + 1, 5):
            x, _ = self._to_px(t, 0)
            cr.move_to(x, MARGIN_T)
            cr.line_to(x, y1)
        for p in range(0, 101, 10):
            _, y = self._to_px(0, p)
            cr.move_to(x0, y)
            cr.line_to(x0 + gw, y)
        cr.stroke()

        # etichette
        cr.set_source_rgba(fg.red, fg.green, fg.blue, 0.85)
        cr.select_font_face("sans")
        cr.set_font_size(11)
        for t in range(int(T_MIN), int(T_MAX) + 1, 10):
            x, _ = self._to_px(t, 0)
            cr.move_to(x - 8, y1 + 16)
            cr.show_text("%d°" % t)
        for p in range(0, 101, 20):
            _, y = self._to_px(0, p)
            cr.move_to(8, y + 4)
            cr.show_text("%d%%" % p)

        # temperatura attuale
        if self.temp is not None and T_MIN <= self.temp <= T_MAX:
            x, _ = self._to_px(self.temp, 0)
            cr.set_source_rgb(1.0, 0.55, 0.15)
            cr.set_line_width(1.4)
            cr.move_to(x, MARGIN_T)
            cr.line_to(x, y1)
            cr.stroke()
            cr.move_to(min(x + 4, x0 + gw - 60), MARGIN_T + 14)
            cr.show_text("CPU %.0f°" % self.temp)

        # curva
        pts = sorted(self.points, key=lambda p: p[0])
        cr.set_source_rgb(0.30, 0.72, 1.0)
        cr.set_line_width(2.4)
        first = True
        for t, p in pts:
            x, y = self._to_px(t, p)
            if first:
                cr.move_to(x, y)
                first = False
            else:
                cr.line_to(x, y)
        cr.stroke()

        # punti
        for idx, (t, p) in enumerate(pts):
            x, y = self._to_px(t, p)
            hot = (self.drag == idx)
            cr.set_source_rgb(1.0, 1.0, 1.0) if hot else cr.set_source_rgb(0.12, 0.45, 0.75)
            cr.arc(x, y, 6.0 if hot else 5.0, 0, 6.2832)
            cr.fill()
            cr.set_source_rgb(0.30, 0.72, 1.0)
            cr.set_line_width(1.6)
            cr.arc(x, y, 6.0 if hot else 5.0, 0, 6.2832)
            cr.stroke()

        return False

    # ------------------------------------------------------------- mouse

    def _hit(self, x, y):
        best, bd = None, HIT_RADIUS
        for idx, (t, p) in enumerate(self.points):
            px, py = self._to_px(t, p)
            d = ((px - x) ** 2 + (py - y) ** 2) ** 0.5
            if d < bd:
                best, bd = idx, d
        return best

    def _on_press(self, widget, event):
        if event.button == 3:                       # rimuovi
            idx = self._hit(event.x, event.y)
            if idx is not None and len(self.points) > 2:
                del self.points[idx]
                self._changed()
            return True
        if event.type == Gdk.EventType._2BUTTON_PRESS:   # aggiungi
            t, p = self._to_data(event.x, event.y)
            t = max(T_MIN, min(T_MAX, t))
            p = max(P_MIN, min(P_MAX, p))
            self.points.append([round(t, 1), round(p, 1)])
            self._changed()
            return True
        idx = self._hit(event.x, event.y)
        if idx is not None:
            self.drag = idx
            return True
        return False

    def _on_motion(self, widget, event):
        if self.drag is None:
            return False
        t, p = self._to_data(event.x, event.y)
        t = max(T_MIN, min(T_MAX, t))
        p = max(P_MIN, min(P_MAX, p))
        pts = sorted(self.points, key=lambda q: q[0])
        i = self.drag
        lo = pts[i - 1][0] + 1 if i > 0 else T_MIN
        hi = pts[i + 1][0] - 1 if i < len(pts) - 1 else T_MAX
        pts[i][0] = round(max(lo, min(hi, t)), 1)
        pts[i][1] = round(p, 1)
        self.points = pts
        self._changed()
        return True

    def _on_release(self, widget, event):
        self.drag = None
        return True

    # ------------------------------------------------------------- azioni

    def _changed(self):
        self.curves[self.name] = [list(p) for p in self.points]
        self.dirty = True
        self.area.queue_draw()
        self._update_info()

    def _update_info(self):
        self.info.set_text("punti: %d   ·   min %.0f%%   ·   max %.0f%%   ·   %s"
                           % (len(self.points),
                              min(p for _, p in self.points),
                              max(p for _, p in self.points),
                              "modifiche non salvate" if self.dirty else "salvata"))

    def _on_select(self, combo):
        name = combo.get_active_text()
        if not name or name == self.name:
            return
        self.name = name
        self.points = [list(p) for p in self.curves[name]]
        self.area.queue_draw()
        self._update_info()

    def _reload_combo(self):
        self.combo.remove_all()
        for k in sorted(self.curves):
            self.combo.append_text(k)
        self.combo.set_active(sorted(self.curves).index(self.name))

    def _ask(self, title, prompt, initial=""):
        dlg = Gtk.Dialog(title=title, transient_for=self, flags=0)
        dlg.add_button("Annulla", Gtk.ResponseType.CANCEL)
        dlg.add_button("OK", Gtk.ResponseType.OK)
        box = dlg.get_content_area()
        box.add(Gtk.Label(label=prompt))
        entry = Gtk.Entry()
        entry.set_text(initial)
        entry.set_activates_default(True)
        box.add(entry)
        dlg.show_all()
        resp = dlg.run()
        text = entry.get_text().strip()
        dlg.destroy()
        return text if resp == Gtk.ResponseType.OK and text else None

    def _on_new(self, _w):
        name = self._ask("Nuova curva", "Nome della curva:", "Curva %d" % (len(self.curves) + 1))
        if not name:
            return
        self.curves[name] = [list(p) for p in PRESETS["Bilanciato"]]
        self.name = name
        self.points = [list(p) for p in self.curves[name]]
        self._reload_combo()
        self._changed()

    def _on_dup(self, _w):
        name = self._ask("Duplica curva", "Nome della copia:", self.name + " copia")
        if not name:
            return
        self.curves[name] = [list(p) for p in self.points]
        self.name = name
        self.points = [list(p) for p in self.curves[name]]
        self._reload_combo()
        self._changed()

    def _on_rename(self, _w):
        name = self._ask("Rinomina", "Nuovo nome:", self.name)
        if not name or name == self.name:
            return
        self.curves[name] = self.curves.pop(self.name)
        if self.active == self.name:
            self.active = name
        self.name = name
        self._reload_combo()

    def _on_delete(self, _w):
        if len(self.curves) <= 1:
            return
        del self.curves[self.name]
        self.name = sorted(self.curves)[0]
        self.points = [list(p) for p in self.curves[self.name]]
        self._reload_combo()
        self._changed()

    def _apply_preset(self, key):
        self.points = [list(p) for p in PRESETS[key]]
        self._changed()

    def _on_mix(self, _w):
        dlg = Gtk.Dialog(title="Combina due curve", transient_for=self, flags=0)
        dlg.add_button("Annulla", Gtk.ResponseType.CANCEL)
        dlg.add_button("Crea", Gtk.ResponseType.OK)
        box = dlg.get_content_area()
        box.set_spacing(6)
        names = sorted(self.curves)
        c1 = Gtk.ComboBoxText()
        c2 = Gtk.ComboBoxText()
        for n in names:
            c1.append_text(n)
            c2.append_text(n)
        c1.set_active(names.index(self.name))
        c2.set_active(0)
        op = Gtk.ComboBoxText()
        for label, key in (("Massimo", "max"), ("Minimo", "min"), ("Media", "avg")):
            op.append_text(label)
        op.set_active(0)
        box.add(Gtk.Label(label="Prima curva:"))
        box.add(c1)
        box.add(Gtk.Label(label="Seconda curva:"))
        box.add(c2)
        box.add(Gtk.Label(label="Operazione:"))
        box.add(op)
        box.add(Gtk.Label(label="Nome risultato:"))
        entry = Gtk.Entry()
        entry.set_text("Combinata")
        box.add(entry)
        dlg.show_all()
        resp = dlg.run()
        a, b = c1.get_active_text(), c2.get_active_text()
        o = ("max", "min", "avg")[op.get_active()]
        name = entry.get_text().strip()
        dlg.destroy()
        if resp != Gtk.ResponseType.OK or not name:
            return
        grid = sorted(set([p[0] for p in self.curves[a]] + [p[0] for p in self.curves[b]]))
        out = []
        for t in grid:
            va, vb = interpolate(self.curves[a], t), interpolate(self.curves[b], t)
            v = max(va, vb) if o == "max" else (min(va, vb) if o == "min" else (va + vb) / 2.0)
            out.append([round(t, 1), round(v, 1)])
        self.curves[name] = out
        self.name = name
        self.points = [list(p) for p in out]
        self._reload_combo()
        self._changed()

    def _on_save(self, _w):
        self.curves[self.name] = [list(p) for p in self.points]
        self.active = self.name
        try:
            save_library(self.curves, self.active)
            self.dirty = False
            self._update_info()
            self.info.set_text("salvato in " + CURVES_PATH)
        except Exception as exc:
            self.info.set_text("errore nel salvataggio: %s" % exc)

    def _tick(self):
        self.temp = cpu_temperature()
        self.area.queue_draw()
        return True


def main():
    win = CurveEditor()
    win.show_all()
    Gtk.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
