.PHONY: build test dev clean

build:
	cd web && npm ci && npm run build
	mkdir -p bin
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/cdk ./cmd/server

test:
	go test -race ./...
	go vet ./...
	cd web && npm test && npm run build

dev:
	go run ./cmd/server

clean:
	rm -rf bin web/dist/assets
