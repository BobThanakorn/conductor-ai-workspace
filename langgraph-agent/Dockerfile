# Python 3.12-slim, pinned to the manifest digest resolved for P6-T1.
ARG PYTHON_IMAGE=python:3.12-slim@sha256:229a2c5bfa27522db7815ea81f9bed70af17ccb9de9fc7ad142b1877b5830d36
FROM ${PYTHON_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY requirements.lock .
RUN pip install --require-hashes --no-cache-dir -r requirements.lock

COPY app.py graph.py models.py ./
RUN mkdir -p /data/langgraph \
    && chown -R 65532:65532 /app /data/langgraph

USER 65532:65532
LABEL org.opencontainers.image.title="conductor-langgraph-agent" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.base.name="python:3.12-slim"
EXPOSE 8010
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8010"]
