//
// fancontrol@filippo — controllo ventola per Cinnamon (nbfc-linux)
//
// Funzionalita' mutuate dai software di riferimento:
//   - CoolerControl : sensori multipli combinabili, profili (Fixed/Graph),
//                     isteresi, response-time, avvisi, calibrazione
//   - Fan Control   : curve a punti con interpolazione, step up/down separati,
//                     isteresi + response time, manuale/fisso
//   - thinkfan      : bande di temperatura sovrapposte (isteresi)
//
// La configurazione sta in settings-schema.json (dialogo Impostazioni
// dell'applet), non piu' nel codice.
//

const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Mainloop = imports.mainloop;

const POLL_MS = 2500;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

// Curve predefinite: coppie [temperatura °C, velocita' %]
const PRESETS = {
    silent: [
        [45, 0], [50, 5], [55, 10], [60, 16], [65, 22],
        [70, 30], [75, 38], [80, 48], [85, 60], [90, 75], [95, 100]
    ],
    balanced: [
        [45, 0], [50, 8], [55, 15], [60, 22], [65, 30],
        [70, 38], [75, 47], [80, 57], [85, 70], [90, 84], [95, 100]
    ],
    performance: [
        [40, 10], [45, 18], [50, 27], [55, 36], [60, 45],
        [65, 55], [70, 65], [75, 78], [80, 90], [85, 100]
    ]
};

const PROFILE_LABELS = {
    silent: "Silenzioso",
    balanced: "Bilanciato",
    performance: "Prestazioni",
    custom: "Personalizzato",
    fixed: "Fisso"
};
const PROFILE_ORDER = ["silent", "balanced", "performance", "custom", "fixed"];

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

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// ------------------------------------------------------------------ applet

class FanControlApplet extends Applet.TextIconApplet {

    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.metadata = metadata;
        this._statePath = GLib.get_home_dir() + "/.config/fancontrol-applet.json";

        // ---- impostazioni (settings-schema.json) ----
        this.settings = new Settings.AppletSettings(this, metadata.uuid, instance_id);
        let bind = (key, prop) => this.settings.bind(key, prop, () => this._onSettingsChanged());
        bind("profile", "_profile");
        bind("customCurve", "_customCurve");
        bind("sensors", "_sensorsSpec");
        bind("sensorAlgorithm", "_sensorAlgo");
        bind("hysteresis", "_hysteresis");
        bind("responseTime", "_responseTime");
        bind("stepUp", "_stepUp");
        bind("stepDown", "_stepDown");
        bind("minSpeed", "_minSpeed");
        bind("maxSpeed", "_maxSpeed");
        bind("fixedSpeed", "_fixedSpeed");
        bind("alertsEnabled", "_alertsEnabled");
        bind("criticalTemp", "_criticalTemp");
        bind("showTemperature", "_showTemperature");

        // ---- stato di esecuzione ----
        this._auto = true;          // interruttore del menu
        this._manual = 50;
        this._ticks = 0;
        this._applied = -1;         // ultimo valore scritto
        this._goal = null;          // obiettivo calcolato
        this._lastEvalTemp = null;  // temperatura all'ultima valutazione della curva
        this._lastChange = 0;       // timestamp dell'ultima scrittura
        this._lastAlert = 0;
        this._temperature = NaN;
        this._statusTemp = NaN;
        this._speed = NaN;
        this._powerProfile = "?";
        this._onAc = true;
        this._batt = NaN;
        this._nbfcOk = false;
        this._sliderSilent = false;
        this._switchSilent = false;

        this._sensors = this._discoverSensors();
        this._loadState();

        // ---- pannello ----
        this.set_applet_icon_symbolic_name("weather-windy-symbolic");
        this.set_applet_label("...");
        this.set_applet_tooltip("Controllo ventola");

        // ---- menu ----
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this._buildMenu();

        this._timeout = Mainloop.timeout_add(POLL_MS, () => { this._tick(); return true; });
        this._tick();
        if (this._auto === false)
            this._writeSpeed(this._manual);
    }

    // ---------------------------------------------------------- impostazioni

    _onSettingsChanged() {
        this._lastEvalTemp = null;          // forza il ricalcolo al prossimo giro
        this._refreshProfileMenu();
        this._refreshMenu();
    }

    _curvePoints() {
        if (this._profile === "custom") {
            let pts = this._parseCurve(this._customCurve);
            if (pts.length >= 2) return pts;
        }
        return PRESETS[this._profile] || PRESETS.balanced;
    }

    _parseCurve(s) {
        let out = [];
        let parts = ("" + s).split(",");
        for (let i = 0; i < parts.length; i++) {
            let m = parts[i].trim().match(/^(-?\d+(?:\.\d+)?)\s*:\s*(-?\d+(?:\.\d+)?)$/);
            if (m) out.push([parseFloat(m[1]), parseFloat(m[2])]);
        }
        out.sort((a, b) => a[0] - b[0]);
        return out;
    }

    // interpolazione lineare fra i punti della curva (come la "Graph" di Fan Control)
    _curveValue(t) {
        let p = this._curvePoints();
        if (p.length === 0) return 0;
        if (t <= p[0][0]) return p[0][1];
        for (let i = 1; i < p.length; i++) {
            let a = p[i - 1], b = p[i];
            if (t <= b[0]) return a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
        }
        return p[p.length - 1][1];
    }

    _computeTarget(t) {
        if (this._profile === "fixed")
            return clamp(Math.round(this._fixedSpeed), 0, 100);

        let target = this._curveValue(t);

        let p = ("" + this._powerProfile).toLowerCase();
        if (p.indexOf("performance") >= 0) target += 10;
        else if (p.indexOf("power-saver") >= 0) target -= 10;

        if (!this._onAc) {                       // a batteria: piu' prudente
            target -= 10;
            if (t < 78) target = Math.min(target, 60);
        }
        return clamp(Math.round(target), this._minSpeed, this._maxSpeed);
    }

    // ---------------------------------------------------------- sensori

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

    // ---------------------------------------------------------- menu

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

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // profilo curva (come i "Profiles" di CoolerControl)
        this._profilesMenu = new PopupMenu.PopupSubMenuMenuItem("Profilo curva");
        this._profileItems = {};
        for (let k = 0; k < PROFILE_ORDER.length; k++) {
            let key = PROFILE_ORDER[k];
            let it = new PopupMenu.PopupMenuItem(PROFILE_LABELS[key]);
            it.connect("activate", () => {
                this.settings.setValue("profile", key);
                this._onSettingsChanged();
            });
            this._profilesMenu.menu.addMenuItem(it);
            this._profileItems[key] = it;
        }
        this.menu.addMenuItem(this._profilesMenu);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

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

        this._refreshProfileMenu();
    }

    _refreshProfileMenu() {
        if (!this._profileItems) return;
        for (let k = 0; k < PROFILE_ORDER.length; k++) {
            let key = PROFILE_ORDER[k];
            this._profileItems[key].label.text =
                PROFILE_LABELS[key] + (key === this._profile ? "   ✓" : "");
        }
        if (this._profilesMenu)
            this._profilesMenu.label.text = "Profilo curva: " + (PROFILE_LABELS[this._profile] || "—");
    }

    on_applet_clicked(event) {
        this.menu.toggle();
    }

    // ---------------------------------------------------------- interazione

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
            this._applied = -1;         // riparte pulito
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

    // ---------------------------------------------------------- ciclo automatico

    // isteresi (rivaluta la curva solo se la temperatura si muove)
    // + response time (intervallo minimo fra due variazioni)
    // + step up/down separati (rampa dolce)
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
            next = this._maxSpeed;                                   // emergenza: subito
        } else if (this._applied < 0) {
            next = this._goal;                                       // primo giro
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

    // ---------------------------------------------------------- lettura stato

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

    _checkAlerts() {
        if (!this._alertsEnabled || isNaN(this._temperature)) return;
        if (this._temperature < this._criticalTemp) return;
        let now = Date.now();
        if (now - this._lastAlert < ALERT_COOLDOWN_MS) return;
        this._lastAlert = now;
        runOut(["notify-send", "-u", "critical", "-i", "dialog-warning",
                "Ventola — temperatura critica",
                Math.round(this._temperature) + " °C (limite " + this._criticalTemp + " °C)"], () => {});
    }

    _tick() {
        runOut(["nbfc", "status"], (out) => {
            this._nbfcOk = !!out;
            if (out) this._parseStatus(out);

            this._temperature = this._readTemperature();
            if (isNaN(this._temperature)) this._temperature = this._statusTemp;

            if (this._ticks % 4 === 0) {
                runOut(["powerprofilesctl", "get"], (o) => {
                    if (o) this._powerProfile = o.trim();
                });
            }
            this._ticks++;

            this._readBattery();
            this._checkAlerts();
            this._refreshMenu();

            if (this._auto) this._updateAuto();
        });
        return true;
    }

    _refreshMenu() {
        let d = (x) => isNaN(x) ? "—" : (Math.round(x * 10) / 10);
        this._iTemp.label.text  = "Temperatura: " + d(this._temperature) + " °C";
        this._iSpeed.label.text = "Ventola: " + d(this._speed) + " %" +
                                  (isNaN(this._goal) || !this._auto ? "" : "  (obiettivo " + d(this._goal) + "%)");
        this._iSens.label.text  = "Sensori: " + this._sensorsLabel();
        this._iProf.label.text  = "Profilo energetico: " + this._powerProfile +
                                  (this._onAc ? "  ·  rete" : "  ·  batteria");
        this._iBatt.label.text  = "Batteria: " + (isNaN(this._batt) ? "—" : this._batt + " %");
        this._iHint.label.text  = this._auto
            ? "Modalita': automatica · isteresi " + this._hysteresis + "°C · risposta " + this._responseTime + "s"
            : "Modalita': manuale " + this._manual + "%";

        let label = "";
        if (this._showTemperature && !isNaN(this._temperature)) label += Math.round(this._temperature) + "° ";
        label += (isNaN(this._speed) ? "—" : Math.round(this._speed) + "%");
        this.set_applet_label(label);

        this.set_applet_tooltip(
            "Ventola " + (isNaN(this._speed) ? "—" : Math.round(this._speed) + "%") +
            " · " + (isNaN(this._temperature) ? "—" : Math.round(this._temperature) + "°C") +
            " · " + (PROFILE_LABELS[this._profile] || "—") +
            " · " + this._powerProfile + (this._onAc ? "" : " · batteria"));
    }

    // ---------------------------------------------------------- persistenza

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
        this._auto = (this._auto === true);     // mai undefined
    }

    on_applet_removed_from_panel() {
        if (this._timeout) {
            Mainloop.source_remove(this._timeout);
            this._timeout = 0;
        }
        try { this.settings.finalize(); } catch (e) {}
        runOut(["nbfc", "set", "--auto"], () => {});   // non lasciarla bloccata
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new FanControlApplet(metadata, orientation, panel_height, instance_id);
}
