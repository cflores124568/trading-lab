# Trading Lab FastAPI backend
# Multi-stage build so the final image doesn't carry build tools
# for the C++ pybind11 kernel.

# Stage 1: Build the C++ backtest kernel 
FROM python:3.12-slim AS builder

WORKDIR /build

# Build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    pybind11-dev \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps first 
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# Copy source and build the C++ kernel
COPY cpp/backtest_core.cpp cpp/CMakeLists.txt* ./
RUN if [ -f CMakeLists.txt ]; then \
        cmake -B build -DCMAKE_BUILD_TYPE=Release && \
        cmake --build build -- -j$(nproc); \
    else \
        echo "No CMakeLists.txt found — skipping C++ build (Python fallback active)"; \
    fi


# Stage 2: Runtime image 
FROM python:3.12-slim AS runtime

WORKDIR /app

# Runtime system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    && rm -rf /var/lib/apt/lists/*

# Copy installed Python packages from builder
COPY --from=builder /install /usr/local

# Copy compiled kernel build output, then move any .so files into /app
COPY --from=builder /build/build/ /tmp/kernel/
RUN find /tmp/kernel -name "*.so*" -exec cp {} /app/ \; 2>/dev/null || true \
    && rm -rf /tmp/kernel

# Copy application source
COPY . .

# Non-root user for security
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

# Uvicorn with 2 workers — adjust based on instance size
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]