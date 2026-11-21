#!/bin/sh
# start the annotator (localhost only). usage: ./run.sh [port]
cd "$(dirname "$0")"
exec .venv/bin/python server.py --port "${1:-8000}"
