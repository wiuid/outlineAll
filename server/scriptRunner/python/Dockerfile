FROM python:3.13-slim-bookworm@sha256:ed86c82274b3c69b52fb5820f358f0bd7df0b603332063cb5c6e32bd220c3e6e AS base

WORKDIR /runtime
COPY requirements.txt ./
RUN python -m pip install --no-cache-dir --disable-pip-version-check -r requirements.txt \
    && python -m pip uninstall --yes pip \
    && rm -rf /root/.cache
COPY outline.py transport.py bootstrap.py ./

FROM base AS tests
COPY *_test.py ./
RUN python -B -m unittest discover -p '*_test.py' -v

FROM base AS runtime
USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["python3", "-I", "-u", "/runtime/bootstrap.py"]
