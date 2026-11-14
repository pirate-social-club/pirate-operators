FROM docker.io/library/node:24.18.1-bookworm-slim@sha256:a09aabc645e86e81e23dab78e0c0f2eaa233cab4277c7188232181a1a8bd5d39
WORKDIR /opt/pirate
# Context is assembled from sealed artifacts by a separately qualified producer.
# No source compilation, package manager, provider CLI or dependency download here.
COPY --chown=1000:1000 runtime/ /opt/pirate/runtime/
COPY --chown=1000:1000 release/ /opt/pirate/release/
COPY --chown=1000:1000 --chmod=0555 workerd /opt/pirate/workerd
USER 1000:1000
ENV NODE_ENV=production
ENTRYPOINT ["/usr/local/bin/node", "/opt/pirate/runtime/launch.mjs"]
CMD ["serve"]
