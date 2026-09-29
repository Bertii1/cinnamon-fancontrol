//
// fancontrol@filippo - controllo ventola per Cinnamon, basato su nbfc-linux
//
// Legge temperatura e velocita' da "nbfc status", il profilo energetico da
// powerprofilesctl e lo stato della batteria da /sys. In modalita' automatica
// calcola un obiettivo e lo applica con "nbfc set -s". Lo slider da' il
// controllo manuale, come il volume nel pannello.
//

const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Mainloop = imports.mainloop;

const POLL_MS = 2500;      // ogni quanto aggiornare (ms)
const RAMP_STEP = 8;       // % massime di variazione per aggiornamento (rampa dolce)
const EMERGENCY_TEMP = 85; // sopra questa temperatura si va subito al valore richiesto

// ---------- utilita' ----------

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

// esegue un comando e restituisce lo stdout (asincrono, non blocca il desktop)
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

// ---------- applet ----------

class FanControlApplet extends Applet.TextIconApplet {

    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.metadata = metadata;
        this._statePath = GLib.get_home_dir() + "/.config/fancontrol-applet.json";

        // stato interno
        this._auto = true;
        this._manual = 35;
        this._ticks = 0;
        this._lastWritten = -1;
        this._temp = NaN;
        this._speed = NaN;
        this._target = NaN;
        this._profile = "?";
        this._onAc = true;
        this._batt = NaN;
        this._nbfcOk = false;

        this._sliderSilent = false;
        this._switchSilent = false;

        this._loadState();

        // pannello: icona + etichetta
        this.set_applet_icon_symbolic_name("weather-windy-symbolic");
        this.set_applet_label("...");
        this.set_applet_tooltip("Controllo ventola");

        // menu a tendina (come il volume)
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        this._buildMenu();

        this._timeout = Mainloop.timeout_add(POLL_MS, () => { this._tick(); return true; });
        this._tick();

        // se l'ultima volta era in manuale, riapplica la velocita' scelta
        if (this._auto === false)
            this._writeSpeed(this._manual);
    }

    // ---------------- menu ----------------

    _infoItem(text) {
        let it = new PopupMenu.PopupMenuItem(text);
        try { it.setSensitive(false); } catch (e) { try { it.actor.reactive = false; } catch (e2) {} }
        return it;
    }

    _buildMenu() {
        this._iTemp  = this._infoItem("Temperatura: —");
        this._iSpeed = this._infoItem("Ventola: —");
        this._iProf  = this._infoItem("Profilo: —");
        this._iBatt  = this._infoItem("Batteria: —");
        this.menu.addMenuItem(this._iTemp);
        this.menu.addMenuItem(this._iSpeed);
        this.menu.addMenuItem(this._iProf);
        this.menu.addMenuItem(this._iBatt);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._sliderItem = new PopupMenu.PopupSliderMenuItem(this._manual / 100);
        this._sliderItem.connect("value-changed", (item, value) => this._onSlider(value));
        this.menu.addMenuItem(this._sliderItem);

        this._iManual = this._infoItem("Velocita' manuale: " + this._manual + "%");
        this.menu.addMenuItem(this._iManual);

        this._autoSwitch = new PopupMenu.PopupSwitchMenuItem(
            "Automatico (temp + profilo + batteria)", this._auto);
        this._autoSwitch.connect("toggled", (item) => this._onAutoToggle(item.state));
        this.menu.addMenuItem(this._autoSwitch);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._iHint = this._infoItem("Trascina lo slider per il controllo manuale");
        this.menu.addMenuItem(this._iHint);
    }

    on_applet_clicked(event) {
        this.menu.toggle();
    }

    // ---------------- interazione ----------------

    _onSlider(value) {
        if (this._sliderSilent) return;
        let pct = Math.max(0, Math.min(100, Math.round(value * 100)));
        this._manual = pct;
        this._iManual.label.text = "Velocita' manuale: " + pct + "%";

        if (this._auto) {              // muovere lo slider disattiva l'automatico
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
            this._lastWritten = -1;    // forza il ricalcolo
            this._tick();              // e applicalo subito, senza aspettare il timer
        } else {
            this._writeSpeed(this._manual);
        }
    }

    _writeSpeed(pct) {
        pct = Math.max(0, Math.min(100, Math.round(pct)));
        this._lastWritten = pct;
        runOut(["nbfc", "set", "-s", String(pct)], (out) => {});
    }

    // ---------------- politica automatica ----------------

    // Rampa dolce: inizia a 45 °C e sale a piccoli passi fino al 100 % a 90 °C
    _curve(t) {
        if (t < 45) return 0;
        if (t < 50) return 8;
        if (t < 55) return 15;
        if (t < 60) return 22;
        if (t < 65) return 30;
        if (t < 70) return 38;
        if (t < 75) return 47;
        if (t < 80) return 57;
        if (t < 85) return 70;
        if (t < 90) return 84;
        return 100;
    }

    // Applica l'obiettivo senza strappi: al massimo RAMP_STEP % per volta.
    // In emergenza (caldo) o al primo giro scrive subito il valore pieno.
    _applySmoothed(goal) {
        let next;
        if (this._lastWritten < 0 || this._temp >= EMERGENCY_TEMP) {
            next = goal;
        } else {
            let d = goal - this._lastWritten;
            if (Math.abs(d) <= RAMP_STEP) next = goal;
            else next = this._lastWritten + (d > 0 ? RAMP_STEP : -RAMP_STEP);
        }
        if (next !== this._lastWritten)
            this._writeSpeed(next);
    }

    _computeTarget() {
        if (isNaN(this._temp)) return null;
        let t = this._temp;
        let target = this._curve(t);

        let p = ("" + this._profile).toLowerCase();
        if (p.indexOf("performance") >= 0) target += 10;
        else if (p.indexOf("power-saver") >= 0 || p.indexOf("powersave") >= 0) target -= 10;

        if (!this._onAc) {                     // a batteria: piu' prudente
            target -= 10;
            if (t < 78) target = Math.min(target, 60);
        }
        return Math.max(0, Math.min(100, Math.round(target)));
    }

    // ---------------- lettura stato ----------------

    _parseStatus(out) {
        let m;
        m = out.match(/Temperature\s*:\s*([\d.]+)/);          this._temp  = m ? parseFloat(m[1]) : NaN;
        m = out.match(/Current Fan Speed\s*:\s*([\d.]+)/);     this._speed = m ? parseFloat(m[1]) : NaN;
        m = out.match(/Target Fan Speed\s*:\s*([\d.]+)/);      this._target = m ? parseFloat(m[1]) : NaN;
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

    _tick() {
        runOut(["nbfc", "status"], (out) => {
            this._nbfcOk = !!out;
            if (out) this._parseStatus(out);

            if (this._ticks % 3 === 0) {
                runOut(["powerprofilesctl", "get"], (o) => {
                    if (o) this._profile = o.trim();
                });
            }
            this._ticks++;

            this._readBattery();
            this._refreshMenu();

            if (this._auto) {
                let goal = this._computeTarget();
                if (goal !== null)
                    this._applySmoothed(goal);
            }
        });
        return true;
    }

    _refreshMenu() {
        let d = (x) => isNaN(x) ? "—" : (Math.round(x * 10) / 10);
        this._iTemp.label.text  = "Temperatura: " + d(this._temp) + " °C";
        this._iSpeed.label.text = "Ventola: " + d(this._speed) + " %" +
                                  (isNaN(this._target) ? "" : "  (obiettivo " + d(this._target) + "%)");
        this._iProf.label.text  = "Profilo: " + this._profile +
                                  (this._onAc ? "  ·  alimentazione rete" : "  ·  a batteria");
        this._iBatt.label.text  = "Batteria: " + (isNaN(this._batt) ? "—" : this._batt + " %");
        this._iHint.label.text  = this._auto ? "Modalita': automatica" : "Modalita': manuale " + this._manual + "%";

        let label = (isNaN(this._temp) ? "—" : Math.round(this._temp) + "°") + " " +
                    (isNaN(this._speed) ? "—" : Math.round(this._speed) + "%");
        this.set_applet_label(label);
        this.set_applet_tooltip(
            "Ventola " + (isNaN(this._speed) ? "—" : Math.round(this._speed) + "%") +
            " · " + (isNaN(this._temp) ? "—" : Math.round(this._temp) + "°C") +
            " · " + this._profile + (this._onAc ? " · rete" : " · batteria"));
    }

    // ---------------- persistenza ----------------

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
            this._auto = (this._auto === true);   // mai undefined
        } catch (e) {}
    }

    on_applet_removed_from_panel() {
        if (this._timeout) {
            Mainloop.source_remove(this._timeout);
            this._timeout = 0;
        }
        // non lasciare la ventola bloccata al valore manuale
        runOut(["nbfc", "set", "--auto"], (out) => {});
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new FanControlApplet(metadata, orientation, panel_height, instance_id);
}
