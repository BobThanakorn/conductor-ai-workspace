FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 HOME=/tmp
WORKDIR /app
ARG REQUIREMENTS
COPY ${REQUIREMENTS} /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY common/app.py ./app.py
USER 65532:65532
EXPOSE 8020
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8020"]
