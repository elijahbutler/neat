# Preview sandbox: runs a customer repo's `next dev` with source tagging. One container per editor session.
# Node 22.12+ is required: Next compiles next.config.ts to CommonJS, which then require()s the ESM tagging wrapper.
FROM node:22-bookworm-slim
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
ENV NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000
