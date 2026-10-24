#!/usr/bin/env bash
# bench_v2.sh — reproducible token bench for openslimedit v2 under opencode.
#
# Measures the total tokens a model processes for a fixed set of small file-edit
# tasks, with the plugin ON vs OFF (OPENSLIMEDIT_DISABLED=1). Reports the median
# total tokens per task and the % delta, so the slimming effect is reproducible
# on any opencode install that loads this plugin.
#
# Why "total tokens" and why reps: the model-visible context is input +
# cache.read; a single run is noisy (agent behaviour varies run-to-run and prompt
# caching is unstable), so each (task, mode) is run REPS times and we take the
# median. Total = input + output + cache.read.
#
# Usage:  bash bench_v2.sh [DATA_DIR] [REPS]
#         default DATA_DIR = $HOME/opencode/bench_osme
#         default REPS     = 2
#
# Requires: opencode v2 on PATH; the openslimedit-v2 plugin loaded globally
#           (it reads OPENSLIMEDIT_DISABLED from the process environment).
set -u
DATA="${1:-$HOME/opencode/bench_osme}"
REPS="${2:-2}"
mkdir -p "$DATA"
cd "$DATA"

# ---- test files (v1-style sizes: 21 / 40 / 115 lines) ----
gen() { : > "$1"; local i; for i in $(seq 1 "$2"); do
  echo "line $i: lorem ipsum dolor sit amet, consectetur adipiscing elit sed do eiusmod." >> "$1"; done; }
gen f21.txt 21
gen f40.txt 40
gen f115.txt 115

# ---- tasks (one per file, v1-style edit shapes) ----
TASKS=(
  "Read f21.txt. Change line 1 so it says exactly: CHANGED. Then reply DONE."
  "Read f40.txt. Change lines 5, 6 and 7 so each says exactly: REPLACED. Then reply DONE."
  "Read f115.txt. Change line 100 so it says exactly: BIG. Then reply DONE."
)

# ---- token reader: session export JSON -> {input,output,cacheread,total} ----
tok() {
  node -e '
    try {
      const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const t = d.info.tokens || {};
      const cr = (t.cache && t.cache.read) || 0;
      console.log(JSON.stringify({ input: t.input || 0, output: t.output || 0, cacheread: cr,
        total: (t.input || 0) + (t.output || 0) + cr }));
    } catch (e) { console.log("EXPORT-FAILED"); }
  ' "$1" 2>/dev/null || echo EXPORT-FAILED
}

RESULTS="$DATA/results.jsonl"
: > "$RESULTS"

run_one() { # $1=taskIdx $2=mode(on|off) $3=rep
  local idx="$1" mode="$2" rep="$3"
  local task="${TASKS[$idx]}"
  local before after new rc t
  before=$(opencode session list 2>/dev/null | grep '^ses_' | awk '{print $1}' | sort)
  if [ "$mode" = "on" ]; then
    opencode run "$task" > "$DATA/run_${mode}_r${rep}.log" 2>&1
  else
    OPENSLIMEDIT_DISABLED=1 opencode run "$task" > "$DATA/run_${mode}_r${rep}.log" 2>&1
  fi
  rc=$?
  after=$(opencode session list 2>/dev/null | grep '^ses_' | awk '{print $1}' | sort)
  new=$(comm -13 <(echo "$before") <(echo "$after") | head -1)
  if [ -n "$new" ]; then
    opencode session export "$new" > "$DATA/exp_${mode}_r${rep}.json" 2>/dev/null
    t=$(tok "$DATA/exp_${mode}_r${rep}.json")
    node -e 'const o={task:process.argv[1],mode:process.argv[2],rep:+process.argv[3],tokens:JSON.parse(process.argv[4])};
      require("fs").appendFileSync(process.argv[5],JSON.stringify(o)+"\n");' "$idx" "$mode" "$rep" "$t" "$RESULTS"
    echo "  [t$idx r$rep $mode] rc=$rc session=$new tokens=$t"
  else
    echo "  [t$idx r$rep $mode] rc=$rc NO-NEW-SESSION (see run_${mode}_r${rep}.log)"
  fi
}

echo "Bench: data=$DATA reps=$REPS model=default(coder) plugin=openslimedit-v2"
for i in "${!TASKS[@]}"; do
  for mode in on off; do
    for r in $(seq 1 "$REPS"); do
      run_one "$i" "$mode" "$r"
    done
  done
done

echo "=== SUMMARY (median total tokens per task, ON vs OFF) ==="
node -e '
  const fs=require("fs");
  const lines=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean);
  const agg={};
  for(const l of lines){ try{const o=JSON.parse(l);const k=o.task+"|"+o.mode;(agg[k]=agg[k]||[]).push(o.tokens.total);}catch(e){} }
  const med=a=>{a=[...a].sort((x,y)=>x-y);const n=a.length;return n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2;};
  const tasks=[...new Set(Object.keys(agg).map(k=>k.split("|")[0])).sort()];
  for(const t of tasks){ for(const mode of ["on","off"]){ const a=agg[t+"|"+mode]||[];
    if(a.length) console.log(`${mode.toUpperCase().padEnd(4)} t${t}  median_total=${med(a).toFixed(0)}  (n=${a.length})`); } }
  console.log("--- % delta (OFF - ON; positive = OFF processes more tokens) ---");
  for(const t of tasks){ const on=agg[t+"|on"]||[],off=agg[t+"|off"]||[];
    if(on.length&&off.length){const o=med(on),f=med(off);
      console.log(`t${t}: ON=${o.toFixed(0)} OFF=${f.toFixed(0)} delta=${((f-o)/o*100).toFixed(1)}%`);} }
' "$RESULTS"
echo "done."
