#!/usr/bin/env bash
# Fase 7 — TEST DI SCRITTURA via canale ACPI (FANW), con ripristino automatico.
# ATTENZIONE: questo scrive NELL'EC. Esegui con:  sudo bash /tmp/opencode/fan-write-acpi.sh
set -u
[ "$(id -u)" -eq 0 ] || { echo "Serve root:  sudo bash $0" >&2; exit 1; }
modprobe acpi_call 2>/dev/null
modprobe ec_sys 2>/dev/null
EC=/sys/kernel/debug/ec/ec0/io

A(){ printf '%s' "$1" > /proc/acpi/call 2>/dev/null; tr -d '\000' < /proc/acpi/call 2>/dev/null | tr -d '\n'; }
R(){ dd if="$EC" bs=1 skip="$1" count=1 status=none | od -An -tu1 | tr -d ' \n'; }
pkg(){ sensors 2>/dev/null | awk -F'[+°]' '/Package id 0/{print $2}'; }
show(){ printf '  FANG(0x8102)=%-7s FANG(0x8106)=%-7s FANG(0x8125)=%-7s FRPM(EC 0x11)=%-4s pkg=%s\n' \
  "$(A "\\_SB.PC00.LPCB.EC0.FANG 0x8102")" \
  "$(A "\\_SB.PC00.LPCB.EC0.FANG 0x8106")" \
  "$(A "\\_SB.PC00.LPCB.EC0.FANG 0x8125")" \
  "$(R 17)" "$(pkg)"; }

dd if="$EC" bs=1 count=256 status=none of=/tmp/opencode/ec_backup2.bin
echo "backup completo EC -> /tmp/opencode/ec_backup2.bin"
echo "================= stato iniziale ================="; show
ORIG=$(A "\\_SB.PC00.LPCB.EC0.FANG 0x8102")

echo "================= A) FANW 0x8102 = 0xFF (massimo), modo invariato ================="
A "\\_SB.PC00.LPCB.EC0.FANW 0x8102 0xFF" >/dev/null; sleep 8; show

echo "================= B) FANW 0x8102 = 0x10 (basso) ================="
A "\\_SB.PC00.LPCB.EC0.FANW 0x8102 0x10" >/dev/null; sleep 8; show

echo "================= C) modo manuale: FANW 0x8106 = 0xFF  poi  0x8102 = 0xFF ================="
A "\\_SB.PC00.LPCB.EC0.FANW 0x8106 0xFF" >/dev/null
A "\\_SB.PC00.LPCB.EC0.FANW 0x8102 0xFF" >/dev/null; sleep 8; show

echo "================= RIPRISTINO ================="
A "\\_SB.PC00.LPCB.EC0.FANW 0x8106 0x05" >/dev/null
A "\\_SB.PC00.LPCB.EC0.FANW 0x8102 $ORIG" >/dev/null
sleep 3; show
echo "================= FATTO ================="
echo "Hai sentito la ventola aumentare in A o C, e calare in B?"
