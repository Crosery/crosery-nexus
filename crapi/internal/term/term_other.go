//go:build !windows

package term

import "os"

func platformSetup() func() { return func() {} }

// Linux 字符控制台（TERM=linux）字形不全，其余终端默认可用。
func platformUnicode() bool { return os.Getenv("TERM") != "linux" }
