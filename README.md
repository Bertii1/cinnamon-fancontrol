# Cinnamon Fan Control (nbfc)

A **[Cinnamon](https://github.com/linuxmint/cinnamon) panel applet** that controls the
laptop fan through [nbfc-linux](https://github.com/nbfc-linux/nbfc-linux), with:

- an **automatic policy** driven by CPU temperature, the power profile
  (performance / balanced / power-saver) *and* battery state;
- a **manual override** through a slider, right in the panel, next to the volume;
- a **smooth ramp** so the fan glides between values instead of jumping.

It was written for an **HP 250 15.6 inch G9 Notebook PC**, a machine whose fan is
not supported by any mainline driver. This repository also contains the nbfc
configuration file for that model and the diagnostic scripts used to
reverse-engineer its embedded controller.

> The applet UI strings are in Italian (`Automatico`, `Velocità manuale`, ...).

## Interface

The panel shows `44° 84%` — CPU temperature and current fan speed. A left click
opens a drop-down menu like the sound applet, with:

- temperature, fan speed, power profile and battery level;
- a slider for the manual fan speed;
- an **Automatic** switch.

Moving the slider turns the automatic mode off; switching it back on restores the
curve. The choice is remembered in `~/.config/fancontrol-applet.json`.

## Automatic policy

The applied speed is a curve value, adjusted by the power profile and the battery
state.

| CPU temperature | Fan |
|-----------------|-----|
| < 45 °C | 0 % |
| 45 – 50 | 8 % |
| 50 – 55 | 15 % |
| 55 – 60 | 22 % |
| 60 – 65 | 30 % |
| 65 – 70 | 38 % |
| 70 – 75 | 47 % |
| 75 – 80 | 57 % |
| 80 – 85 | 70 % |
| 85 – 90 | 84 % |
| ≥ 90 °C | 100 % |

Adjustments:

- `performance` profile: **+10 %**, `power-saver`: **−10 %**;
- on battery: **−10 %** and capped at **60 %** (cap lifted above 78 °C);
- the ramp is limited to `RAMP_STEP = 8 %` per update (every 2.5 s), so the fan
  moves gradually. Above `EMERGENCY_TEMP = 85 °C` the limit is bypassed.

All of these live in `_curve()` and `_computeTarget()` in
`fancontrol@filippo/applet.js`.

## Requirements

- Linux Mint / Cinnamon (tested on Cinnamon 6.6)
- `nbfc-linux`
- `acpi_call` — the fan speed is written through an ACPI method
- `ec_sys` — used to read the fan speed back from the EC

## Install

### 1. nbfc-linux

On Linux Mint 22 (Ubuntu *noble* base):

```
wget https://github.com/nbfc-linux/nbfc-linux/releases/download/0.5.3/linux-mint-22-nbfc-linux_0.5.3_amd64.deb
sudo apt install ./linux-mint-22-nbfc-linux_0.5.3_amd64.deb
```

### 2. Kernel modules

```
sudo apt install acpi-call-dkms

printf 'acpi_call\n' | sudo tee /etc/modules-load.d/acpi_call.conf
printf 'ec_sys\n'    | sudo tee /etc/modules-load.d/ec_sys.conf
sudo modprobe acpi_call ec_sys
```

### 3. Configuration

```
sudo cp "configs/HP 250 G9 Notebook PC.json" /usr/share/nbfc/configs/
sudo nbfc config --set "HP 250 G9 Notebook PC"
sudo systemctl enable --now nbfc_service
sudo nbfc set --auto
```

### 4. Applet

```
mkdir -p ~/.local/share/cinnamon/applets
cp -r fancontrol@filippo ~/.local/share/cinnamon/applets/
```

Then right-click the panel → *Applets* → **Controllo Ventola** → *Add*.
If it does not show up, restart Cinnamon: `Alt+F2`, `r`, `Enter`.

## HP 250 G9: why a custom configuration

On this machine the fan has no usable ACPI or mainline interface:

- `platform_profile` (cool / quiet / balanced / performance) is advertised, but
  the firmware **ignores it**: the board is absent from the `hp-wmi` thermal
  profile tables, so the value is stored and never applied, and reading it back
  fails with `EINVAL` (`Unknown EC layout for board`).
- `hp-wmi` exposes `fan1_input` / `pwm1_enable` but **no `pwm1`**, and rejects
  `pwm1_enable = 1` (manual mode is Victus-S-only).
- The ACPI fan objects (`PNP0C0B`) are inert (`max_state = 1`, no `_FST`/`_FSL`).

The fan is managed by the embedded controller. Its shared-memory map (`PECM` /
`ECMM`, region at `0xFE0B0800`) declares the relevant fields:

| offset | field | meaning |
|--------|-------|---------|
| `0x11` | `FRPM` | current fan speed |
| `0x12` | `FNMX` | maximum |
| `0x13` | `FNMN` | minimum |
| `0x14` | `FWPM` | write / target |

Writing these through `ec_sys` does nothing — the EC only accepts writes through
its ACPI command channel:

```
\_SB.PC00.LPCB.EC0.FANW <addr> <value>
```

This is the very same interface the HP 250 **G8** configuration uses (address
`0x8102`, with `0x8106` selecting the mode: `0x05` = automatic, `0xFF` = manual).
The shipped configuration therefore reads the fan speed from the raw EC register
`0x11` and writes through `FANW 0x8102`.

To return the EC to automatic mode when the service stops, the configuration
also resets `0x8106` to `0x05`.

## Diagnostics

`tools/` holds the scripts used to get there — they are written for this machine
and are meant as a starting point for other models:

- `01-ec-probe.sh` — read-only EC dump at idle and under CPU load, to find which
  registers track the fan.
- `02-erib-map.sh` — maps the ACPI (`ERIB` / `FANG`) address space.
- `03-acpi-write-test.sh` — controlled single-register write test, with a full EC
  backup and automatic restore.

**Read the scripts before running them**: `03-*` writes to the embedded
controller. Wrong registers can disturb unrelated hardware (there are reports of
HP laptops refusing to charge afterwards). Always back up the EC first.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).

The nbfc configuration is derived from the
[nbfc-linux](https://github.com/nbfc-linux/nbfc-linux) configuration set, which is
also GPL-3.0.
