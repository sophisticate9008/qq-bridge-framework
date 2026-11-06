FROM node:24.12.0-bookworm-slim
WORKDIR /opt/qbf
# CI supplies the exact same verified framework archive used by native installations.
COPY framework.tar.gz /tmp/framework.tar.gz
RUN tar -xzf /tmp/framework.tar.gz --strip-components=1 -C /opt/qbf \
    && rm /tmp/framework.tar.gz \
    && npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && mkdir -p /opt/qbf/runtime /opt/qbf/data /opt/qbf/workspace /opt/qbf/private \
    && chown -R node:node /opt/qbf
ENV NODE_ENV=production QQ_BRIDGE_FRAMEWORK_CONTAINER=1
USER node
VOLUME ["/opt/qbf/data", "/opt/qbf/workspace", "/opt/qbf/private"]
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3210/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "dist/scripts/docker-entrypoint.js"]
