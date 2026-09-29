//
// fancontrol@filippo — controllo ventola per Cinnamon (nbfc-linux)
//
// Funzionalita' (mutuate da CoolerControl, Fan Control, thinkfan, fan2go):
//   curve          : libreria di curve con nome, editor grafico esterno,
//                    interpolazione lineare, profili, velocita' fissa,
//                    "segui il profilo energetico"
//   sensori        : multipli, con massimo / media / minimo
//   reattivita'    : isteresi, tempo di risposta, step up/down separati
//   sicurezza      : bypass d'emergenza, failsafe sensori, avvisi granulari
//   diagnostica    : storico grafico, test ventola, log CSV
//
// La configurazione sta in settings-schema.json; le curve in
// ~/.config/fancontrol/curves.json (gestite da curve-editor.py).
//

const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const St = imports.gi.St;
const Mainloop = imports.mainloop;

const POLL_MS = 2500;
const HISTORY_MAX = 120;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

const CURVES_PATH = GLib.get_home_dir() + "/.config/fancontrol/curves.json";
const CURVES_DIR = GLib.get_home_dir() + "/.config/fancontrol";
const LOG_PATH = GLib.get_home_dir() + "/.local/share/fancontrol/history.csv";

// curve incorporate (stesse dell'editor)
const BUILTIN = {
    "Silenzioso": [[45, 0], [50, 5], [55, 10], [60, 16], [65, 22],
                   [70, 30], [75, 38], [80, 48], [85, 60], [90, 75], [95, 100]],
    "Bilanciato": [[45, 0], [50, 8], [55, 15], [60, 22], [65, 30],
                   [70, 38], [75, 47], [80, 57], [85, 70], [90, 84], [95, 100]],
    "Prestazioni": [[40, 10], [45, 18], [50, 27], [55, 36], [60, 45],
                    [65, 55], [70, 65], [75, 78], [80, 90], [85, 100]],
    "Aggressivo": [[35, 20], [40, 30], [45, 42], [50, 55], [55, 68],
                   [60, 80], [65, 92], [70, 100]],
    "Silenzio estremo": [[55, 0], [60, 10], [65, 20], [70, 32], [75, 45],
                         [80, 60], [85, 78], [90, 95], [95, 100]]
};
const BUILTIN_ORDER = ["Silenzioso", "Bilanciato", "Prestazioni", "Aggressivo", "Silenzio estremo"];

// ------------------------------------------------------------------ utilita'

function bytesToString(data) {
    try {
        if (typeof TextDecoder !== 'undefined')
            return new TextDecoder().decode(data);
    } catch (e) {}
    try { return imports.byteArray.toString(data); } catch (e) {}
    return "" + data;
}

function readSys(path) {
    try {
        let [ok, contents] = Gio.File.new_for_path(path).load_contents(null);
        if (!ok) return null;
        return bytesToString(contents).trim();
    } catch (e) { return null; }
}

function runOut(argv, cb) {
    let proc;
    try {
        proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE);
    } catch (e) {
        global.logError("[fancontrol] spawn fallito: " + e);
        cb(null);
        return;
    }
    proc.communicate_utf8_async(null, null, (p, res) => {
        let out = null;
        try {
            let [, stdout] = p.communicate_utf8_finish(res);
            out = stdout;
        } catch (e) { out = null; }
        cb(out);
    });
}

function notify(title, body, urgency) {
    runOut(["notify-send", "-u", urgency || "normal", "-i", "weather-windy-symbolic",
            title, body], () => {});
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function interpolate(points, t) {
    if (!points || points.length === 0) return 0;
    if (t <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
        let a = points[i - 1], b = points[i];
        if (t <= b[0]) return a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
    }
    return points[points.length - 1][1];
}

// ------------------------------------------------------- storico (sparkline)

const HistoryItem = class HistoryItem extends PopupMenu.PopupBaseMenuItem {
    constructor() {
        super({ activate: false, hover: false });
        this._area = new St.DrawingArea({ width: 260, height: 54 });
        this.addActor(this._area, { span: -1, expand: true });
        this._area.connect("repaint", (area) => this._onRepaint(area));
        this._temps = [];
        this._fans = [];
    }
    push(t, f) {
        if (!isNaN(t)) { this._temps.push(t); if (this._temps.length > HISTORY_MAX) this._temps.shift(); }
        if (!isNaN(f)) { this._fans.push(f); if (this._fans.length > HISTORY_MAX) this._fans.shift(); }
        try { this._area.queue_repaint(); } catch (e) {}
    }
    _onRepaint(area) {
        try {
            let cr = area.get_context();
            let size = area.get_surface_size();
            let w = size[0], h = size[1];

            cr.set_source_rgb(0.10, 0.11, 0.13);
            cr.rectangle(0, 0, w, h);
            cr.fill();

            let draw = (arr, lo, hi, r, g, b) => {
                if (arr.length < 2) return;
                cr.set_source_rgb(r, g, b);
                cr.set_line_width(1.6);
                for (let i = 0; i < arr.length; i++) {
                    let x = i / (HISTORY_MAX - 1) * w;
                    let y = h - clamp((arr[i] - lo) / (hi - lo), 0, 1) * h;
                    if (i === 0) cr.move_to(x, y); else cr.line_to(x, y);
                }
                cr.stroke();
            };
            draw(this._temps, 30, 100, 1.0, 0.45, 0.25);   // temperatura
            draw(this._fans, 0, 100, 0.35, 0.75, 1.0);     // ventola
        } catch (e) {}
    }
};

// ------------------------------------------------------------------ applet

class FanControlApplet extends Applet.TextIconApplet {

    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.metadata = metadata;
        this._statePath = GLib.get_home_dir() + "/.config/fancontrol-applet.json";

        // ---- impostazioni ----
        this.settings = new Settings.AppletSettings(this, metadata.uuid, instance_id);
        let bind = (key, prop) => this.settings.bind(key, prop, () => this._onSettingsChanged());
        bind("curve", "_curve");
        bind("fixedSpeed", "_fixedSpeed");
        bind("sensors", "_sensorsSpec");
        bind("sensorAlgorithm", "_sensorAlgo");
        bind("hysteresis", "_hysteresis");
        bind("responseTime", "_responseTime");
        bind("stepUp", "_stepUp");
        bind("stepDown", "_stepDown");
        bind("minSpeed", "_minSpeed");
        bind("maxSpeed", "_maxSpeed");
        bind("criticalTemp", "_criticalTemp");
        bind("alertsEnabled", "_alertsEnabled");
        bind("notifyCritical", "_notifyCritical");
        bind("notifyFanFail", "_notifyFanFail");
        bind("notifySensorMissing", "_notifySensorMissing");
        bind("notifyCurveChange", "_notifyCurveChange");
        bind("followPowerProfile", "_followPowerProfile");
        bind("logToFile", "_logToFile");
        bind("showTemperature", "_showTemperature");

        // ---- runtime ----
        this._auto = true;
        this._manual = 50;
        this._ticks = 0;
        this._applied = -1;
        this._goal = null;
        this._lastEvalTemp = null;
        this._lastChange = 0;
        this._lastAlert = 0;
        this._missing = 0;
        this._testing = false;
        this._temperature = NaN;
        this._statusTemp = NaN;
        this._speed = NaN;
        this._powerProfile = "?";
        this._lastPowerProfile = null;
        this._onAc = true;
        this._batt = NaN;
        this._sliderSilent = false;
        this._switchSilent = false;
        this._fanFailAlerted = false;

        this._sensors = this._discoverSensors();
        this._library = this._loadLibrary();
        this._loadState();

        this.set_applet_icon_symbolic_name("weather-windy-symbolic");
        this.set_applet_label("...");
        this.set_applet_tooltip("Controllo ventola");

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this._buildMenu();

        this._timeout = Mainloop.timeout_add(POLL_MS, () => { this._tick(); return true; });
        this._tick();
        if (this._auto === false)
            this._writeSpeed(this._manual);
    }

    // -------------------------------------------------------- impostazioni

    _onSettingsChanged() {
        this._lastEvalTemp = null;
        this._refreshCurveMenu();
        this._refreshMenu();
    }

    _loadLibrary() {
        try {
            let [ok, data] = Gio.File.new_for_path(CURVES_PATH).load_contents(null);
            if (!ok) return {};
            let o = JSON.parse(bytesToString(data));
            let out = {};
            for (let k in (o.curves || {})) {
                let pts = [];
                for (let p of o.curves[k]) {
                    if (p.length >= 2) pts.push([parseFloat(p[0]), parseFloat(p[1])]);
                }
                if (pts.length >= 2) { pts.sort((a, b) => a[0] - b[0]); out[k] = pts; }
            }
            return out;
        } catch (e) { return {}; }
    }

    _allCurveNames() {
        let names = BUILTIN_ORDER.slice();
        for (let k in this._library) if (names.indexOf(k) < 0) names.push(k);
        return names;
    }

    _parseInline(s) {
        let out = [];
        let parts = ("" + s).split(",");
        for (let i = 0; i < parts.length; i++) {
            let m = parts[i].trim().match(/^(-?\d+(?:\.\d+)?)\s*:\s*(-?\d+(?:\.\d+)?)$/);
            if (m) out.push([parseFloat(m[1]), parseFloat(m[2])]);
        }
        out.sort((a, b) => a[0] - b[0]);
        return out;
    }

    _isFixed() {
        let c = ("" + this._curve).trim().toLowerCase();
        return c === "fixed" || c === "fisso";
    }

    _activePoints() {
        let name = ("" + this._curve).trim();
        if (this._library[name]) return this._library[name];
        if (BUILTIN[name]) return BUILTIN[name];
        let inline = this._parseInline(name);
        if (inline.length >= 2) return inline;
        return BUILTIN["Bilanciato"];
    }

    // -------------------------------------------------------- sensori

    _discoverSensors() {
        let out = [];
        for (let i = 0; i < 32; i++) {
            let base = "/sys/class/hwmon/hwmon" + i;
            let name = readSys(base + "/name");
            if (!name) continue;
            for (let j = 1; j <= 32; j++) {
                let p = base + "/temp" + j + "_input";
                if (readSys(p) !== null) out.push({ name: name, path: p });
            }
        }
        return out;
    }

    _readTemperature() {
        let want = ("" + this._sensorsSpec).toLowerCase()
                     .split(",").map(s => s.trim()).filter(s => s.length > 0);
        let vals = [];
        for (let i = 0; i < this._sensors.length; i++) {
            let s = this._sensors[i];
            if (want.length > 0 && want.indexOf(s.name.toLowerCase()) < 0) continue;
            let raw = readSys(s.path);
            if (raw === null) continue;
            let d = parseFloat(raw) / 1000;
            if (!isNaN(d)) vals.push(d);
        }
        if (vals.length === 0) return NaN;
        if (this._sensorAlgo === "average") {
            let sum = 0;
            for (let i = 0; i < vals.length; i++) sum += vals[i];
            return sum / vals.length;
        }
        if (this._sensorAlgo === "min") return Math.min.apply(null, vals);
        return Math.max.apply(null, vals);
    }

    _sensorsLabel() {
        let want = ("" + this._sensorsSpec).split(",").map(s => s.trim()).filter(s => s.length > 0);
        let n = want.length > 0 ? want.length : this._sensors.length;
        let algo = { max: "max", min: "min", average: "media" }[this._sensorAlgo] || "max";
        return n + " sensori · " + algo;
    }

    // -------------------------------------------------------- menu

    _infoItem(text) {
        let it = new PopupMenu.PopupMenuItem(text);
        try { it.setSensitive(false); } catch (e) { try { it.actor.reactive = false; } catch (e2) {} }
        return it;
    }

    _buildMenu() {
        this._iTemp = this._infoItem("Temperatura: —");
        this._iSpeed = this._infoItem("Ventola: —");
        this._iSens = this._infoItem("Sensori: —");
        this._iProf = this._infoItem("Profilo energetico: —");
        this._iBatt = this._infoItem("Batteria: —");
        this.menu.addMenuItem(this._iTemp);
        this.menu.addMenuItem(this._iSpeed);
        this.menu.addMenuItem(this._iSens);
        this.menu.addMenuItem(this._iProf);
        this.menu.addMenuItem(this._iBatt);

        // storico temperatura/ventola
        this._history = new HistoryItem();
        this.menu.addMenuItem(this._history);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // ---- curva
        this._curveMenu = new PopupMenu.PopupSubMenuMenuItem("Curva");
        this._curveItems = {};
        for (let name of this._allCurveNames()) {
            let it = new PopupMenu.PopupMenuItem(name);
            it.connect("activate", () => { this.settings.setValue("curve", name); this._onSettingsChanged(); });
            this._curveMenu.menu.addMenuItem(it);
            this._curveItems[name] = it;
        }
        let itFixed = new PopupMenu.PopupMenuItem("Fisso");
        itFixed.connect("activate", () => { this.settings.setValue("curve", "fixed"); this._onSettingsChanged(); });
        this._curveMenu.menu.addMenuItem(itFixed);
        this._curveItems["__fixed__"] = itFixed;
        this.menu.addMenuItem(this._curveMenu);

        // ---- notifiche
        this._notifyMenu = new PopupMenu.PopupSubMenuMenuItem("Notifiche");
        let addSwitch = (label, prop, key) => {
            let sw = new PopupMenu.PopupSwitchMenuItem(label, this.settings.getValue(key));
            sw.connect("toggled", (item) => this.settings.setValue(key, item.state));
            this._notifyMenu.menu.addMenuItem(sw);
            return sw;
        };
        addSwitch("Attive", null, "alertsEnabled");
        addSwitch("Temperatura critica", null, "notifyCritical");
        addSwitch("Ventola non risponde", null, "notifyFanFail");
        addSwitch("Sensori non leggibili", null, "notifySensorMissing");
        addSwitch("Cambio curva automatico", null, "notifyCurveChange");
        this.menu.addMenuItem(this._notifyMenu);

        // ---- strumenti
        this._toolsMenu = new PopupMenu.PopupSubMenuMenuItem("Strumenti");
        let mk = (label, cb) => {
            let it = new PopupMenu.PopupMenuItem(label);
            it.connect("activate", cb);
            this._toolsMenu.menu.addMenuItem(it);
            return it;
        };
        mk("Editor curve…", () => {
            runOut(["python3", GLib.get_home_dir() +
                    "/.local/share/cinnamon/applets/fancontrol@filippo/curve-editor.py"], () => {
                this._library = this._loadLibrary();
                this._onSettingsChanged();
            });
        });
        mk("Test ventola (0→100%)", () => this._runFanTest());
        mk("Segui il profilo energetico", () => {
            this.settings.setValue("followPowerProfile", !this._followPowerProfile);
        });
        mk("Registra storico su file", () => {
            this.settings.setValue("logToFile", !this._logToFile);
        });
        mk("Apri cartella configurazione", () => {
            runOut(["xdg-open", CURVES_DIR], () => {});
        });
        this.menu.addMenuItem(this._toolsMenu);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // ---- manuale
        this._sliderItem = new PopupMenu.PopupSliderMenuItem(this._manual / 100);
        this._sliderItem.connect("value-changed", (item, value) => this._onSlider(value));
        this.menu.addMenuItem(this._sliderItem);

        this._iManual = this._infoItem("Velocita' manuale: " + this._manual + "%");
        this.menu.addMenuItem(this._iManual);

        this._autoSwitch = new PopupMenu.PopupSwitchMenuItem("Automatico", this._auto);
        this._autoSwitch.connect("toggled", (item) => this._onAutoToggle(item.state));
        this.menu.addMenuItem(this._autoSwitch);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._iHint = this._infoItem("—");
        this.menu.addMenuItem(this._iHint);

        this._refreshCurveMenu();
    }

    _refreshCurveMenu() {
        if (!this._curveItems) return;
        let current = ("" + this._curve).trim();
        for (let name in this._curveItems) {
            let active = this._isFixed() ? (name === "__fixed__") : (name === current);
            this._curveItems[name].label.text = (name === "__fixed__" ? "Fisso" : name) + (active ? "   ✓" : "");
        }
        this._curveMenu.label.text = "Curva: " + (this._isFixed() ? "Fisso" : current);
    }

    on_applet_clicked(event) { this.menu.toggle(); }

    // -------------------------------------------------------- interazione

    _onSlider(value) {
        if (this._sliderSilent) return;
        let pct = clamp(Math.round(value * 100), 0, 100);
        this._manual = pct;
        this._iManual.label.text = "Velocita' manuale: " + pct + "%";
        if (this._auto) {
            this._auto = false;
            this._switchSilent = true;
            try { this._autoSwitch.setToggleState(false); } catch (e) {}
            this._switchSilent = false;
            this._saveState();
        }
        this._writeSpeed(pct);
    }

    _onAutoToggle(state) {
        if (this._switchSilent) return;
        this._auto = (state === true);
        this._saveState();
        if (this._auto) {
            this._applied = -1;
            this._goal = null;
            this._lastEvalTemp = null;
            this._tick();
        } else {
            this._writeSpeed(this._manual);
        }
    }

    _writeSpeed(pct) {
        pct = clamp(Math.round(pct), 0, 100);
        this._applied = pct;
        runOut(["nbfc", "set", "-s", String(pct)], () => {});
    }

    // -------------------------------------------------------- ciclo automatico

    _computeTarget(t) {
        if (this._isFixed())
            return clamp(Math.round(this._fixedSpeed), 0, 100);

        let target = interpolate(this._activePoints(), t);

        let p = ("" + this._powerProfile).toLowerCase();
        if (p.indexOf("performance") >= 0) target += 10;
        else if (p.indexOf("power-saver") >= 0) target -= 10;

        if (!this._onAc) {
            target -= 10;
            if (t < 78) target = Math.min(target, 60);
        }
        return clamp(Math.round(target), this._minSpeed, this._maxSpeed);
    }

    _updateAuto() {
        let t = this._temperature;
        if (isNaN(t)) return;
        let now = Date.now();

        if (this._lastEvalTemp === null || Math.abs(t - this._lastEvalTemp) >= this._hysteresis) {
            this._goal = this._computeTarget(t);
            this._lastEvalTemp = t;
        }
        if (this._goal === null) return;

        let next;
        if (t >= this._criticalTemp) {
            next = this._maxSpeed;
        } else if (this._applied < 0) {
            next = this._goal;
        } else {
            if (now - this._lastChange < this._responseTime * 1000) return;
            let step = (this._goal > this._applied) ? this._stepUp : this._stepDown;
            if (Math.abs(this._goal - this._applied) <= step) next = this._goal;
            else next = this._applied + (this._goal > this._applied ? step : -step);
        }
        next = clamp(Math.round(next), this._minSpeed, this._maxSpeed);
        if (next !== this._applied) {
            this._lastChange = now;
            this._writeSpeed(next);
        }
    }

    // -------------------------------------------------------- test ventola

    _runFanTest() {
        if (this._testing) return;
        this._testing = true;
        let steps = [0, 25, 50, 75, 100];
        let i = 0;
        let results = [];

        let step = () => {
            if (i >= steps.length) {
                this._testing = false;
                this._lastEvalTemp = null;               // l'automatico riprende
                let msg = results.join("  ·  ");
                this._iHint.label.text = "Test: " + msg;
                notify("Test ventola", msg, "normal");
                return;
            }
            let pct = steps[i++];
            this._writeSpeed(pct);
            GLib.timeout_add(3200, () => {
                results.push(pct + "% → " + (isNaN(this._speed) ? "?" : Math.round(this._speed)) + "%");
                step();
                return false;
            });
        };
        step();
    }

    // -------------------------------------------------------- letture

    _parseStatus(out) {
        let m;
        m = out.match(/Temperature\s*:\s*([\d.]+)/);        this._statusTemp = m ? parseFloat(m[1]) : NaN;
        m = out.match(/Current Fan Speed\s*:\s*([\d.]+)/);   this._speed = m ? parseFloat(m[1]) : NaN;
    }

    _readBattery() {
        let ac = readSys("/sys/class/power_supply/ACAD/online")
              ?? readSys("/sys/class/power_supply/AC/online")
              ?? readSys("/sys/class/power_supply/ADP1/online");
        this._onAc = (ac === null) ? true : (ac === "1");
        let cap = readSys("/sys/class/power_supply/BAT1/capacity")
               ?? readSys("/sys/class/power_supply/BAT0/capacity");
        this._batt = (cap === null) ? NaN : parseInt(cap, 10);
    }

    _maybeSwitchCurve() {
        if (!this._followPowerProfile || this._powerProfile === this._lastPowerProfile) return;
        this._lastPowerProfile = this._powerProfile;
        let map = { "performance": "Prestazioni", "balanced": "Bilanciato", "power-saver": "Silenzioso" };
        let target = map[this._powerProfile];
        if (!target || this._curve === target) return;
        this.settings.setValue("curve", target);
        if (this._notifyCurveChange && this._alertsEnabled)
            notify("Curva ventola", "Profilo " + this._powerProfile + " → curva \"" + target + "\"", "low");
    }

    _checkAlerts() {
        if (!this._alertsEnabled || isNaN(this._temperature)) return;
        if (!this._notifyCritical || this._temperature < this._criticalTemp) return;
        let now = Date.now();
        if (now - this._lastAlert < ALERT_COOLDOWN_MS) return;
        this._lastAlert = now;
        notify("Ventola — temperatura critica",
               Math.round(this._temperature) + " °C (limite " + this._criticalTemp + " °C)", "critical");
    }

    _checkFanFail() {
        if (!this._alertsEnabled || !this._notifyFanFail) return;
        if (isNaN(this._speed) || isNaN(this._temperature)) return;
        if (this._applied < 50) return;
        if (this._speed >= 5) { this._fanFailAlerted = false; return; }
        if (this._fanFailAlerted) return;
        this._fanFailAlerted = true;
        notify("Ventola non risponde",
               "Comandata al " + this._applied + "%, legge " + Math.round(this._speed) + "%", "critical");
    }

    _checkSensors() {
        if (!isNaN(this._temperature)) { this._missing = 0; return; }
        this._missing++;
        if (this._missing !== 4) return;
        runOut(["nbfc", "set", "--auto"], () => {});      // failsafe
        if (this._notifySensorMissing && this._alertsEnabled)
            notify("Sensori non leggibili", "Controllo restituito a nbfc", "critical");
    }

    _log() {
        if (!this._logToFile || this._ticks % 4 !== 0) return;
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(LOG_PATH), 0o755);
            let line = new Date().toISOString().replace(/\.\d+Z$/, "") + "," +
                       (isNaN(this._temperature) ? "" : this._temperature.toFixed(1)) + "," +
                       (isNaN(this._speed) ? "" : this._speed.toFixed(1)) + "," +
                       this._powerProfile + "," + this._applied + "\n";
            let stream = Gio.File.new_for_path(LOG_PATH).append_to(Gio.FileCreateFlags.NONE, null);
            stream.write_all(line, null);
            stream.close(null);
        } catch (e) {}
    }

    _tick() {
        runOut(["nbfc", "status"], (out) => {
            if (out) this._parseStatus(out);

            this._temperature = this._readTemperature();
            if (isNaN(this._temperature)) this._temperature = this._statusTemp;

            if (this._ticks % 4 === 0) {
                runOut(["powerprofilesctl", "get"], (o) => {
                    if (o) { this._powerProfile = o.trim(); this._maybeSwitchCurve(); }
                });
            }
            this._ticks++;

            this._readBattery();
            this._checkSensors();
            this._checkAlerts();
            this._checkFanFail();
            this._log();
            this._history.push(this._temperature, this._speed);
            this._refreshMenu();


            if (this._auto && !this._testing) this._updateAuto();
        });
        return true;
    }

    _refreshMenu() {
        let d = (x) => isNaN(x) ? "—" : (Math.round(x * 10) / 10);
        this._iTemp.label.text  = "Temperatura: " + d(this._temperature) + " °C";
        this._iSpeed.label.text = "Ventola: " + d(this._speed) + " %" +
            (this._auto && this._goal !== null ? "  (obiettivo " + this._goal + "%)" : "");
        this._iSens.label.text  = "Sensori: " + this._sensorsLabel();
        this._iProf.label.text  = "Profilo energetico: " + this._powerProfile +
                                  (this._onAc ? "  ·  rete" : "  ·  batteria");
        this._iBatt.label.text  = "Batteria: " + (isNaN(this._batt) ? "—" : this._batt + " %");
        this._iHint.label.text  = this._testing ? "Test ventola in corso…"
            : (this._auto
                ? "Automatica · " + (this._isFixed() ? "fisso " + this._fixedSpeed + "%" : this._curve) +
                  " · isteresi " + this._hysteresis + "°C · risposta " + this._responseTime + "s"
                : "Manuale " + this._manual + "%");

        let label = "";
        if (this._showTemperature && !isNaN(this._temperature)) label += Math.round(this._temperature) + "° ";
        label += (isNaN(this._speed) ? "—" : Math.round(this._speed) + "%");
        this.set_applet_label(label);

        this.set_applet_tooltip(
            "Ventola " + (isNaN(this._speed) ? "—" : Math.round(this._speed) + "%") +
            " · " + (isNaN(this._temperature) ? "—" : Math.round(this._temperature) + "°C") +
            " · " + (this._isFixed() ? "fisso" : this._curve) +
            " · " + this._powerProfile + (this._onAc ? "" : " · batteria"));
    }

    // -------------------------------------------------------- persistenza

    _saveState() {
        try {
            GLib.file_set_contents(this._statePath,
                JSON.stringify({ auto: (this._auto === true), manual: this._manual }));
        } catch (e) {}
    }

    _loadState() {
        try {
            let [ok, data] = GLib.file_get_contents(this._statePath);
            if (!ok) return;
            let o = JSON.parse(bytesToString(data));
            if (typeof o.auto === "boolean") this._auto = o.auto;
            if (typeof o.manual === "number") this._manual = o.manual;
        } catch (e) {}
        this._auto = (this._auto === true);
    }

    on_applet_removed_from_panel() {
        if (this._timeout) { Mainloop.source_remove(this._timeout); this._timeout = 0; }
        try { this.settings.finalize(); } catch (e) {}
        runOut(["nbfc", "set", "--auto"], () => {});
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new FanControlApplet(metadata, orientation, panel_height, instance_id);
}
