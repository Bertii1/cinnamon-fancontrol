#!/usr/bin/env bash
# Fase 6 — mappa lo spazio indirizzi ERIB (FANG) per trovare temp/ventola
# Esegui con:  sudo bash /tmp/opencode/ecmap.sh
set -u
[ "$(id -u)" -eq 0 ] || { echo "Serve root:  sudo bash $0" >&2; exit 1; }
modprobe ec_sys 2>/dev/null
EC=/sys/kernel/debug/ec/ec0/io

acpi(){ printf '%s' "$1" > /proc/acpi/call 2>/dev/null; tr -d '\000' < /proc/acpi/call 2>/dev/null | tr -d '\n'; }
pkg(){  sensors 2>/dev/null | awk -F'[+°]' '/Package id 0/{print $2}'; }
scan(){ # $1=base(decimal) $2=outfile
  : > "$2"; local i a v
  for i in $(seq 0 255); do
    a=$(printf '0x%04X' $(( $1 + i )))
    v=$(acpi "\\_SB.PC00.LPCB.EC0.FANG $a")
    printf '%02X %s\n' "$i" "$v" >> "$2"
  done
}

echo "================= scansione a riposo (pkg=$(pkg)) ================="
scan $((0x8100)) /tmp/opencode/erib_81_idle.txt
scan $((0x0000)) /tmp/opencode/erib_00_idle.txt

echo "================= carico CPU 30s ================="
if command -v stress-ng >/dev/null; then
  stress-ng --cpu 0 --timeout 30s --quiet &
else
  for _ in $(seq 1 "$(nproc)"); do ( while :; do :; done ) & done
fi
sleep 24
echo "sotto carico (pkg=$(pkg))"
scan $((0x8100)) /tmp/opencode/erib_81_load.txt
scan $((0x0000)) /tmp/opencode/erib_00_load.txt
pkill -P $$ 2>/dev/null; sleep 2
echo "dopo (pkg=$(pkg))"

echo
echo "================= bancа 0x81xx: chi cambia col carico ================="
paste /tmp/opencode/erib_81_idle.txt /tmp/opencode/erib_81_load.txt | \
  awk '$2!=$4 {printf "  0x81%s  idle=%-8s load=%s\n",$1,$2,$4}'

echo
echo "================= bancа 0x00xx: chi cambia col carico ================="
paste /tmp/opencode/erib_00_idle.txt /tmp/opencode/erib_00_load.txt | \
  awk '$2!=$4 {printf "  0x00%s  idle=%-8s load=%s\n",$1,$2,$4}'

echo
echo "================= 0x81xx vs EC(ec_sys): quanti coincidono? ================="
dd if="$EC" bs=1 count=256 status=none > /tmp/opencode/ec_dump2.bin
od -An -tu1 -v /tmp/opencode/ec_dump2.bin | tr -s ' ' '\n' | sed '/^$/d' > /tmp/opencode/ec_bytes.txt
paste /tmp/opencode/erib_81_idle.txt /tmp/opencode/ec_bytes.txt | \
  awk 'function h2d(s,   i,c,d,r){r=0; for(i=1;i<=length(s);i++){c=toupper(substr(s,i,1)); d=index("0123456789ABCDEF",c)-1; if(d<0)return -1; r=r*16+d} return r}
       {v=$2; if (v ~ /^0x/) {n++; if (h2d(substr(v,3))==$3+0) m++}}
       END{printf "  coincidenze esatte: %d / %d\n", m+0, n}'
echo "  (primi 24 offset: ERIB_0x81 vs EC, per occhio)"
paste /tmp/opencode/erib_81_idle.txt /tmp/opencode/ec_bytes.txt | head -24

echo
echo "================= FATTO ================="
echo "Incolla tutto; i file /tmp/opencode/erib_*.txt restano per analisi."
