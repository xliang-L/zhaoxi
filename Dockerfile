FROM node:24-trixie
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv git ca-certificates procps \
    poppler-utils tesseract-ocr tesseract-ocr-chi-sim \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@12.15.0
WORKDIR /app
COPY . .
RUN python3 -m venv .venv && .venv/bin/pip install --no-cache-dir -e . \
    && .venv/bin/python scripts/install_runtime.py
ENV PATH="/app/.venv/bin:$PATH" \
    ZHAOXI_HOST=0.0.0.0 \
    ZHAOXI_DATA_DIR=/var/lib/zhaoxi \
    ZHAOXI_RUNTIME_ROOT=/app/data/runtime/openclaw \
    ZHAOXI_DOCUMENT_PYTHON=/app/.venv/bin/python
RUN mkdir -p /var/lib/zhaoxi && chown -R node:node /app /var/lib/zhaoxi
USER node
VOLUME ["/var/lib/zhaoxi"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8787/api/health',timeout=3)"
CMD ["zhaoxi", "--host", "0.0.0.0", "--port", "8787"]
