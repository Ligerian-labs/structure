#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo 'Usage: benchmark.sh BASELINE CANDIDATE NEW_REPORT_DIR -- COMMAND [ARG ...]' >&2
  echo 'Requires hyperfine, bun and git; jj for Jujutsu workspaces. WARMUP=2 RUNS=15.' >&2
  exit 2
}

[[ $# -ge 5 && "$4" == -- ]] || usage
baseline=$(cd -- "$1" && pwd -P)
candidate=$(cd -- "$2" && pwd -P)
report=$3
shift 4
[[ "$baseline" != "$candidate" ]] || { echo 'Use two distinct checkouts.' >&2; exit 2; }
[[ ! -e "$report" ]] || { echo 'Report directory already exists.' >&2; exit 2; }
warmup=${WARMUP:-2}
runs=${RUNS:-15}
[[ "$warmup" =~ ^[0-9]+$ && "$runs" =~ ^[1-9][0-9]*$ ]] || usage
for tool in hyperfine bun git shasum; do
  command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 2; }
done

# %q preserves each argument for the explicit Bash shell used by hyperfine.
printf -v workload '%q ' "$@"
printf -v baseline_command 'cd -- %q && %s' "$baseline" "$workload"
printf -v candidate_command 'cd -- %q && %s' "$candidate" "$workload"

checkout_metadata() {
  local checkout=$1
  echo "Checkout: $checkout"
  if [[ -e "$checkout/.jj" ]]; then
    # Git in a non-colocated jj workspace can resolve the parent's checkout.
    jj -R "$checkout" log --no-graph -r @ -T 'commit_id ++ "\n"'
    jj -R "$checkout" diff --stat
  else
    [[ "$(git -C "$checkout" rev-parse --show-toplevel)" == "$checkout" ]] || {
      echo 'Expected a repository root.' >&2; return 2;
    }
    git -C "$checkout" rev-parse HEAD
    git -C "$checkout" status --short
  fi
  if [[ -f "$checkout/bun.lock" ]]; then
    shasum -a 256 "$checkout/bun.lock"
  fi
  if [[ -x "$checkout/node_modules/.bin/turbo" ]]; then
    "$checkout/node_modules/.bin/turbo" --version
  fi
}

mkdir -p -- "$(dirname -- "$report")"
mkdir -- "$report"
{
  echo '# Benchmark environment'
  echo
  echo '```text'
  date -u '+%Y-%m-%dT%H:%M:%SZ'
  uname -srm
  if [[ "$(uname -s)" == Darwin ]]; then
    sysctl -n machdep.cpu.brand_string hw.ncpu hw.memsize
  elif [[ -r /proc/cpuinfo ]]; then
    awk -F: '/model name/ { print $2; exit }' /proc/cpuinfo
    getconf _NPROCESSORS_ONLN
    awk '/MemTotal/ { print }' /proc/meminfo
  fi
  command -v bun
  bun --version
  hyperfine --version
  printf 'Warmup: %s\nRuns: %s\nCommand: %s\n' "$warmup" "$runs" "$workload"
  echo
  checkout_metadata "$baseline"
  echo
  checkout_metadata "$candidate"
  echo '```'
  echo
  echo 'Samples include process startup and use warmed OS caches. No CPU profiler is enabled by this runner.'
} > "$report/environment.md"

# No --ignore-failure: a failed workload must never become a performance win.
hyperfine --shell=bash --warmup "$warmup" --runs "$runs" \
  --export-json "$report/results.json" --export-markdown "$report/results.md" \
  --command-name baseline "$baseline_command" \
  --command-name candidate "$candidate_command"
echo "Reports: $report"
