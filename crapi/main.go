package main

import (
	"os"

	"github.com/crosery/crapi/internal/cli"
)

// version 由构建脚本通过 -ldflags "-X main.version=..." 注入。
var version = "dev"

func main() {
	os.Exit(cli.Main(version, os.Args[1:]))
}
