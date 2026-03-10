#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()   { echo -e "${BLUE}[SETUP]${NC} $1"; }
ok()    { echo -e "${GREEN}[  OK ]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN ]${NC} $1"; }
fail()  { echo -e "${RED}[FAIL ]${NC} $1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/python-backend"
VENV_DIR="$BACKEND_DIR/venv"
MIN_PYTHON_MAJOR=3
MIN_PYTHON_MINOR=8

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  AI Diagram Generator - Dev Setup${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# -----------------------------------
# 1. Check Node.js
# -----------------------------------
log "Checking Node.js..."
if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install it from https://nodejs.org"
fi
NODE_VERSION=$(node -v)
ok "Node.js $NODE_VERSION"

# -----------------------------------
# 2. Check npm
# -----------------------------------
log "Checking npm..."
if ! command -v npm &>/dev/null; then
  fail "npm not found."
fi
NPM_VERSION=$(npm -v)
ok "npm v$NPM_VERSION"

# -----------------------------------
# 3. Check / Install ffmpeg
# -----------------------------------
log "Checking ffmpeg..."
if command -v ffmpeg &>/dev/null; then
  FFMPEG_VERSION=$(ffmpeg -version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1)
  ok "ffmpeg v$FFMPEG_VERSION"
else
  warn "ffmpeg not found — attempting to install..."
  if [[ "$OSTYPE" == "darwin"* ]]; then
    if command -v brew &>/dev/null; then
      log "Installing ffmpeg via Homebrew..."
      brew install ffmpeg
      ok "ffmpeg installed via Homebrew"
    else
      warn "Homebrew not found. Install ffmpeg manually: brew install ffmpeg"
    fi
  elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    if command -v apt &>/dev/null; then
      log "Installing ffmpeg via apt..."
      sudo apt update && sudo apt install -y ffmpeg
      ok "ffmpeg installed via apt"
    elif command -v dnf &>/dev/null; then
      log "Installing ffmpeg via dnf..."
      sudo dnf install -y ffmpeg
      ok "ffmpeg installed via dnf"
    else
      warn "Could not auto-install ffmpeg. Install it manually for your distro."
    fi
  else
    warn "Please install ffmpeg manually: https://ffmpeg.org/download.html"
  fi

  # Verify
  if command -v ffmpeg &>/dev/null; then
    FFMPEG_VERSION=$(ffmpeg -version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1)
    ok "ffmpeg v$FFMPEG_VERSION"
  else
    warn "ffmpeg not installed — video encoding will fall back to browser (WebM only)"
  fi
fi

# -----------------------------------
# 4. Find Python 3.8+
# -----------------------------------
log "Checking Python..."
PYTHON_CMD=""

for cmd in python3 python; do
  if command -v "$cmd" &>/dev/null; then
    PY_VERSION=$("$cmd" --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
    PY_MAJOR=$(echo "$PY_VERSION" | cut -d. -f1)
    PY_MINOR=$(echo "$PY_VERSION" | cut -d. -f2)

    if [ "$PY_MAJOR" -ge "$MIN_PYTHON_MAJOR" ] && [ "$PY_MINOR" -ge "$MIN_PYTHON_MINOR" ]; then
      PYTHON_CMD="$cmd"
      break
    else
      warn "$cmd found but version $PY_VERSION is below minimum $MIN_PYTHON_MAJOR.$MIN_PYTHON_MINOR"
    fi
  fi
done

if [ -z "$PYTHON_CMD" ]; then
  fail "Python $MIN_PYTHON_MAJOR.$MIN_PYTHON_MINOR+ not found. Install from https://python.org"
fi

PY_FULL_VERSION=$("$PYTHON_CMD" --version 2>&1)
PY_PATH=$(command -v "$PYTHON_CMD")
ok "$PY_FULL_VERSION ($PY_PATH)"

# Check pip
log "Checking pip..."
if ! "$PYTHON_CMD" -m pip --version &>/dev/null; then
  warn "pip not found, attempting to install..."
  "$PYTHON_CMD" -m ensurepip --upgrade 2>/dev/null || fail "Could not install pip. Install it manually."
fi
PIP_VERSION=$("$PYTHON_CMD" -m pip --version | grep -oE '[0-9]+\.[0-9]+')
ok "pip v$PIP_VERSION"

# Check venv module
log "Checking venv module..."
if ! "$PYTHON_CMD" -m venv --help &>/dev/null; then
  fail "Python venv module not available. On Ubuntu/Debian: sudo apt install python3-venv"
fi
ok "venv module available"

# -----------------------------------
# 5. Install Node dependencies
# -----------------------------------
log "Installing Node.js dependencies..."
cd "$SCRIPT_DIR"
npm install
ok "Node.js dependencies installed"

# -----------------------------------
# 6. Setup Python virtual environment
# -----------------------------------
if [ ! -d "$VENV_DIR" ]; then
  log "Creating Python virtual environment..."
  "$PYTHON_CMD" -m venv "$VENV_DIR"
  ok "Virtual environment created at $VENV_DIR"
else
  ok "Virtual environment already exists"
fi

# Activate venv
if [ -f "$VENV_DIR/bin/activate" ]; then
  source "$VENV_DIR/bin/activate"
elif [ -f "$VENV_DIR/Scripts/activate" ]; then
  source "$VENV_DIR/Scripts/activate"
else
  fail "Could not find venv activation script"
fi

# -----------------------------------
# 7. Install Python dependencies
# -----------------------------------
log "Upgrading pip in venv..."
pip install --upgrade pip --quiet

log "Installing Python backend dependencies..."
pip install -r "$BACKEND_DIR/requirements.txt"
ok "Python dependencies installed"

# -----------------------------------
# 8. Verify key Python packages
# -----------------------------------
log "Verifying Python packages..."
MISSING=0
for pkg in sanic numpy cv2 PIL ultralytics onnxruntime psutil rembg; do
  if python -c "import $pkg" 2>/dev/null; then
    ok "  $pkg"
  else
    warn "  $pkg failed to import"
    MISSING=$((MISSING + 1))
  fi
done

if [ "$MISSING" -gt 0 ]; then
  warn "$MISSING package(s) could not be verified (may still work at runtime)"
fi

# -----------------------------------
# 9. Summary
# -----------------------------------
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Setup Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "  Node.js:  $NODE_VERSION"
echo -e "  npm:      v$NPM_VERSION"
echo -e "  Python:   $PY_FULL_VERSION"
echo -e "  Venv:     $VENV_DIR"
echo ""
echo -e "  ${BLUE}Run dev:${NC}  npm run dev:full"
echo -e "  ${BLUE}Backend:${NC}  npm run backend:start"
echo -e "  ${BLUE}Desktop:${NC}  npm run electron:dev"
echo ""
