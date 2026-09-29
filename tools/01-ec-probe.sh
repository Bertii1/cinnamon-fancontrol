#!/usr/bin/env bash
# Fase 2 — mappatura EC (SOLA LETTURA) + carico CPU + sbirciata al DSDT
# Esegui con:  sudo bash /tmp/opencode/ec-probe.sh
set -u

[ "$(id -u)" -eq 0 ] || { echo "Serve root:  sudo bash $0" >&2; exit 1; }

EC=/sys/kernel/debug/ec/ec0/io
modprobe ec_sys 2>/dev/null
if [ ! -e "$EC" ]; then
  echo "!! EC non accessibile ($EC). ec_sys caricato? debugfs montato?" >&2
  ls /sys/kernel/debug/ 2>&1
  exit 1
fi

dump() { dd if="$EC" bs=1 count=256 status=none 2>/dev/null | od -An -v -tu1 | tr -s ' ' '\n' | sed '/^$/d'; }
pkg()  { sensors 2>/dev/null | awk -F'[+°]' '/Package id 0/{print $2}'; }
fan1() { cat /sys/class/hwmon/hwmon5/fan1_input 2>/dev/null; }
state(){ printf 'pkg=%-6s fan1=%-6s' "$(pkg)" "$(fan1)"; }

echo "================= CAMPIONAMENTO EC ================="
printf 'a riposo : '; state; echo
dump > /tmp/ec_idle.txt

echo "-- metto la CPU sotto carico (~40s) --"
if command -v stress-ng >/dev/null; then
  stress-ng --cpu 0 --timeout 40s --quiet & LOAD=$!
elif command -v stress >/dev/null; then
  stress --cpu "$(nproc)" --timeout 40s & LOAD=$!
else
  for _ in $(seq 1 "$(nproc)"); do ( while :; do :; done ) & done
  LOAD=0
fi

sleep 18; printf 'sotto carico: '; state; echo; dump > /tmp/ec_t18.txt
sleep 18; printf 'sotto carico: '; state; echo; dump > /tmp/ec_t36.txt

[ "$LOAD" -ne 0 ] 2>/dev/null && kill "$LOAD" 2>/dev/null
pkill -P $$ 2>/dev/null
sleep 3; printf 'riposo     : '; state; echo; dump > /tmp/ec_after.txt

echo
echo "=========== REGISTRI EC CHE CAMBIANO (candidati) ==========="
paste /tmp/ec_idle.txt /tmp/ec_t18.txt /tmp/ec_t36.txt /tmp/ec_after.txt | \
awk 'BEGIN{printf "  off    riposo  t18   t36   dopo\n"} \
     { if ($1!=$2 || $2!=$3 || $3!=$4) printf "  0x%02X    %4d  %4d  %4d  %4d\n", NR-1, $1,$2,$3,$4 }'

echo
echo "=========== DSDT: la scheda e' parente delle OMEN? ==========="
if command -v acpidump >/dev/null; then
  acpidump -b -n DSDT >/dev/null 2>&1 && f=DSDT.dat
else
  f=/tmp/DSDT.bin; cat /sys/firmware/acpi/tables/DSDT > "$f" 2>/dev/null
fi
[ -n "${f:-}" ] && [ -s "$f" ] && echo "DSDT: $f ($(stat -c%s "$f") byte)" || echo "DSDT non recuperato"
if [ -s "${f:-/nonexistent}" ]; then
  echo "-- nomi leggibili nel DSDT --"
  strings "$f" | grep -aoE '(_TMP|_FSL|_FST|TZ[0-9]{2}|FAN[0-9]|THERM[A-Z]*|8A1D|OMEN|HPWMI)' | sort | uniq -c | sort -rn | head -20
  if command -v iasl >/dev/null; then
    echo "-- disassemblo con iasl --"
    iasl -d -p /tmp/dsdt.dsl "$f" >/dev/null 2>&1 && \
      grep -nE '0x95|0x63|8A1D|THERMAL|ThermalProfile|_FSL|_FST|FAN' /tmp/dsdt.dsl | head -30
  else
    echo "(iasl non installato: apt-get install acpica-tools per il disassemblaggio)"
  fi
fi

echo
echo "=========== FATTO ==========="
echo "Copia/incolla tutto l'output."
