# syntax=docker/dockerfile:1.7

FROM golang:1.27.1-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" \
    -o /out/weblens-crawler ./cmd/weblens-crawler

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -S weblens \
    && adduser -S -G weblens weblens
COPY --from=build /out/weblens-crawler /usr/local/bin/weblens-crawler
USER weblens
EXPOSE 8081
ENTRYPOINT ["/usr/local/bin/weblens-crawler"]
