MODULE  := github.com/0xsmw/manifold/cli
VERSION ?= $(shell git -C $(CURDIR) describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -X '$(MODULE)/internal/cli.Version=$(VERSION)'
BIN     := ./bin/manifold

.PHONY: build test clean fmt vet tidy

build:
	mkdir -p bin
	go build -ldflags "$(LDFLAGS)" -o $(BIN) .

test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -l .

tidy:
	go mod tidy

clean:
	rm -rf bin
