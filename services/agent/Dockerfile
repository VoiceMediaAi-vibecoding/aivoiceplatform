FROM python:3.11-slim

WORKDIR /app

RUN pip install uv

COPY pyproject.toml uv.lock* ./
RUN uv sync --no-dev

COPY src/ ./src/

# Pre-download Silero VAD + turn_detector models. Pass placeholder LiveKit
# creds so the fail-fast check in agent.py doesn't abort the build (the
# real creds are injected at runtime via docker-compose env_file).
RUN LIVEKIT_API_KEY=buildplaceholder LIVEKIT_API_SECRET=buildplaceholder \
    uv run python src/agent.py download-files

# Pre-download turn_detector (multilingual turn detection) model files
# so multilingual mode works in air-gapped containers at runtime.
RUN uv run python -c "from livekit.plugins.turn_detector import EOUPlugin; from livekit.plugins.turn_detector.multilingual import _EUORunnerMultilingual; EOUPlugin(_EUORunnerMultilingual).download_files()"

CMD ["uv", "run", "python", "src/agent.py", "start"]
