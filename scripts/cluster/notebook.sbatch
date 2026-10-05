#!/bin/bash
# Private Jupyter inside a Slurm allocation, opened from sciencewithagents' QUARK panel.
# Choose the account, partition and resources from the project's instructions (or ask the
# owner), copy this file to the cluster and submit it there, for example:
#   sbatch --account=ACCOUNT --partition=PARTITION notebook.sbatch [notebook-folder]
# Load the site's Python/Jupyter environment below if `jupyter` is not already on PATH.
#SBATCH --job-name=notebook
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=2
#SBATCH --mem=8G
#SBATCH --time=02:00:00
#SBATCH --output=notebook-%j.log
set -euo pipefail

[[ "${SLURM_JOB_ID:-}" =~ ^[0-9]{1,20}$ ]] || {
  echo "Submit this with sbatch; notebooks never run on a login node." >&2
  exit 1
}
command -v jupyter >/dev/null || {
  echo "jupyter is not on PATH on $(hostname -s); load your Python environment first." >&2
  exit 1
}
umask 077
# Slurm opens the job's output and error files before this runs, with the submitting shell's
# umask. Make them private before Jupyter writes: Jupyter masks an environment token in its
# startup URLs and request logs, but an error on a token-bearing request can still print it.
# This acts on the open files themselves, wherever --output/--error put them; pipes and devices
# are left alone. If a log file cannot be made private, Jupyter does not start.
python3 - <<'PY' || {
import os, stat
for fd in (1, 2):
    if stat.S_ISREG(os.fstat(fd).st_mode):
        os.fchmod(fd, 0o600)
        if stat.S_IMODE(os.fstat(fd).st_mode) & 0o077:
            raise SystemExit(1)
PY
  echo "This job's log could not be made private, so Jupyter was not started." >&2
  exit 1
}
dir="$HOME/.sciencewithagents/notebooks"
mkdir -p "$dir"
chmod 700 "$dir"
file="$dir/$SLURM_JOB_ID.json"
trap 'rm -f "$file"' EXIT TERM INT

node="$(hostname -s)"
# FASRC documents notebook ports 6818..11845; other sites can set these bounds.
# Probe the same compute-node interfaces Jupyter will use, rather than an arbitrary
# ephemeral port that the site's login-to-compute firewall may not permit.
port="$(python3 - "${SWA_NOTEBOOK_PORT_MIN:-6818}" "${SWA_NOTEBOOK_PORT_MAX:-11845}" <<'PY_PORT'
import socket, sys
raw_min, raw_max = sys.argv[1:]
try:
    low, high = int(raw_min), int(raw_max)
    if not 1024 <= low <= high <= 65535:
        raise ValueError()
except ValueError:
    raise SystemExit("Notebook port bounds must be integers from 1024 to 65535, with min <= max.")
for candidate in range(low, high + 1):
    with socket.socket() as sock:
        try:
            sock.bind(("0.0.0.0", candidate))
        except OSError:
            continue
        print(candidate)
        break
else:
    raise SystemExit("No available notebook port in the configured range.")
PY_PORT
)"
# The token travels in the environment, not the command line other node users can list, and
# Jupyter then prints it as "token=..." in its startup URLs.
JUPYTER_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
export JUPYTER_TOKEN
base_url="/notebooks/$SLURM_JOB_ID/"
printf '{"node":"%s","port":%s,"token":"%s","baseUrl":"%s"}\n' "$node" "$port" "$JUPYTER_TOKEN" "$base_url" >"$file"
chmod 600 "$file"

cd "${1:-$HOME}"
# Compute nodes can resolve their own name to a different interface than login nodes do.
# Listen on this compute node's IPv4 interfaces; the token and private SSH forward remain.
jupyter lab --no-browser --ip=0.0.0.0 --port="$port" --ServerApp.port_retries=0 --ServerApp.base_url="$base_url"
