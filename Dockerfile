# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:24-alpine AS frontend
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS backend
RUN apk add --no-cache ca-certificates
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend /src/web/dist ./web/dist
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w" -o /out/cdk ./cmd/server \
    && mkdir -p /out/data

FROM scratch
LABEL org.opencontainers.image.title="AICDK" \
    org.opencontainers.image.description="Self-service CDK redemption with a Go API proxy and embedded React UI" \
    org.opencontainers.image.source="https://github.com/AkinoKaede/aicdk"
COPY --from=backend /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=backend /out/cdk /app/cdk
COPY --from=backend --chown=65532:65532 /out/data /data
USER 65532:65532
ENV LISTEN_ADDR=:8080 DATA_DIR=/data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["/app/cdk", "healthcheck"]
ENTRYPOINT ["/app/cdk"]
