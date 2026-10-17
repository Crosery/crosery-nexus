package harness

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

// Obj 是保持键顺序的 JSON 对象。用它改用户的配置文件，
// 不会把用户手写的字段顺序打乱成字母序。
type Obj struct {
	keys []string
	m    map[string]any
}

// NewObj 创建空对象。
func NewObj() *Obj { return &Obj{m: map[string]any{}} }

// O 用成对的 key、value 快速构造对象：O("a", 1, "b", "x")。
func O(kv ...any) *Obj {
	o := NewObj()
	for i := 0; i+1 < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
	return o
}

func (o *Obj) Get(k string) (any, bool) { v, ok := o.m[k]; return v, ok }

// Str 读取字符串字段。
func (o *Obj) Str(k string) string { s, _ := o.m[k].(string); return s }

// Has 报告键是否存在。
func (o *Obj) Has(k string) bool { _, ok := o.m[k]; return ok }

// Set 写入键值；已存在的键保留原位置。
func (o *Obj) Set(k string, v any) {
	if _, ok := o.m[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.m[k] = v
}

// Delete 删除键。
func (o *Obj) Delete(k string) {
	if _, ok := o.m[k]; !ok {
		return
	}
	delete(o.m, k)
	for i, kk := range o.keys {
		if kk == k {
			o.keys = append(o.keys[:i], o.keys[i+1:]...)
			break
		}
	}
}

// Keys 返回按原顺序排列的键。
func (o *Obj) Keys() []string { return append([]string(nil), o.keys...) }

// Child 取子对象；不存在或不是对象时新建并替换。
func (o *Obj) Child(k string) *Obj {
	if c, ok := o.m[k].(*Obj); ok {
		return c
	}
	c := NewObj()
	o.Set(k, c)
	return c
}

// ParseJSON 解析 JSON / JSONC（允许注释、尾逗号、UTF-8 BOM）。空内容返回空对象。
// hadComments 报告原文是否带注释——带注释的文件重写后注释会丢失，调用方应提示。
func ParseJSON(data []byte) (o *Obj, hadComments bool, err error) {
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})
	if len(bytes.TrimSpace(data)) == 0 {
		return NewObj(), false, nil
	}
	clean, had := stripJSONC(data)
	dec := json.NewDecoder(bytes.NewReader(clean))
	dec.UseNumber()
	v, err := decodeValue(dec)
	if err != nil {
		return nil, had, err
	}
	obj, ok := v.(*Obj)
	if !ok {
		return nil, had, errors.New("配置文件顶层不是 JSON 对象")
	}
	return obj, had, nil
}

// ParseJSONArray 解析顶层为数组的 JSON（如 WorkBuddy 的 models.json）。
func ParseJSONArray(data []byte) ([]any, error) {
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})
	if len(bytes.TrimSpace(data)) == 0 {
		return nil, nil
	}
	clean, _ := stripJSONC(data)
	dec := json.NewDecoder(bytes.NewReader(clean))
	dec.UseNumber()
	v, err := decodeValue(dec)
	if err != nil {
		return nil, err
	}
	arr, ok := v.([]any)
	if !ok {
		return nil, errors.New("配置文件顶层不是 JSON 数组")
	}
	return arr, nil
}

func decodeValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			o := NewObj()
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k, ok := kt.(string)
				if !ok {
					return nil, fmt.Errorf("非法的对象键 %v", kt)
				}
				v, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				o.Set(k, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return o, nil
		case '[':
			arr := []any{}
			for dec.More() {
				v, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return arr, nil
		}
		return nil, fmt.Errorf("意外的分隔符 %v", t)
	default:
		return t, nil
	}
}

// stripJSONC 去掉 // 与 /* */ 注释以及对象/数组末尾的逗号，字符串内部原样保留。
func stripJSONC(src []byte) ([]byte, bool) {
	// 第一遍：剥除注释
	var noComments bytes.Buffer
	had := false
	inStr, esc := false, false
	for i := 0; i < len(src); i++ {
		c := src[i]
		if inStr {
			noComments.WriteByte(c)
			switch {
			case esc:
				esc = false
			case c == '\\':
				esc = true
			case c == '"':
				inStr = false
			}
			continue
		}
		switch {
		case c == '"':
			inStr = true
			noComments.WriteByte(c)
		case c == '/' && i+1 < len(src) && src[i+1] == '/':
			had = true
			for i < len(src) && src[i] != '\n' {
				i++
			}
			noComments.WriteByte('\n')
		case c == '/' && i+1 < len(src) && src[i+1] == '*':
			had = true
			i += 2
			for i+1 < len(src) && !(src[i] == '*' && src[i+1] == '/') {
				i++
			}
			i++
			noComments.WriteByte(' ')
		default:
			noComments.WriteByte(c)
		}
	}

	// 第二遍：剥除对象/数组尾部多余的逗号（因为注释已被剥离，向前 lookahead 只有空白符）
	clean := noComments.Bytes()
	var out bytes.Buffer
	inStr, esc = false, false
	for i := 0; i < len(clean); i++ {
		c := clean[i]
		if inStr {
			out.WriteByte(c)
			switch {
			case esc:
				esc = false
			case c == '\\':
				esc = true
			case c == '"':
				inStr = false
			}
			continue
		}
		if c == '"' {
			inStr = true
			out.WriteByte(c)
			continue
		}
		if c == ',' {
			j := i + 1
			for j < len(clean) && (clean[j] == ' ' || clean[j] == '\t' || clean[j] == '\r' || clean[j] == '\n') {
				j++
			}
			if j < len(clean) && (clean[j] == '}' || clean[j] == ']') {
				continue
			}
		}
		out.WriteByte(c)
	}
	return out.Bytes(), had
}

// MarshalJSON 以两个空格缩进输出，保持键顺序，不转义 <>&。
func MarshalJSON(v any) []byte {
	var b bytes.Buffer
	writeValue(&b, v, "")
	b.WriteByte('\n')
	return b.Bytes()
}

func writeValue(w *bytes.Buffer, v any, indent string) {
	next := indent + "  "
	switch t := v.(type) {
	case *Obj:
		if len(t.keys) == 0 {
			w.WriteString("{}")
			return
		}
		w.WriteString("{\n")
		for i, k := range t.keys {
			w.WriteString(next)
			writeString(w, k)
			w.WriteString(": ")
			writeValue(w, t.m[k], next)
			if i < len(t.keys)-1 {
				w.WriteByte(',')
			}
			w.WriteByte('\n')
		}
		w.WriteString(indent + "}")
	case []any:
		if len(t) == 0 {
			w.WriteString("[]")
			return
		}
		if allScalars(t) && scalarLen(t) <= 72 {
			w.WriteByte('[')
			for i, e := range t {
				if i > 0 {
					w.WriteString(", ")
				}
				writeValue(w, e, next)
			}
			w.WriteByte(']')
			return
		}
		w.WriteString("[\n")
		for i, e := range t {
			w.WriteString(next)
			writeValue(w, e, next)
			if i < len(t)-1 {
				w.WriteByte(',')
			}
			w.WriteByte('\n')
		}
		w.WriteString(indent + "]")
	case []string:
		arr := make([]any, len(t))
		for i, s := range t {
			arr[i] = s
		}
		writeValue(w, arr, indent)
	case []*Obj:
		arr := make([]any, len(t))
		for i, s := range t {
			arr[i] = s
		}
		writeValue(w, arr, indent)
	case string:
		writeString(w, t)
	case nil:
		w.WriteString("null")
	default:
		enc := json.NewEncoder(w)
		enc.SetEscapeHTML(false)
		_ = enc.Encode(t)
		w.Truncate(w.Len() - 1)
	}
}

func writeString(w io.Writer, s string) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	_, _ = w.Write(bytes.TrimRight(b.Bytes(), "\n"))
}

func allScalars(a []any) bool {
	for _, e := range a {
		switch e.(type) {
		case *Obj, []any:
			return false
		}
	}
	return true
}

func scalarLen(a []any) int {
	n := 0
	for _, e := range a {
		n += len(fmt.Sprint(e)) + 4
	}
	return n
}

// Strs 把任意数组转换为字符串切片（非字符串元素忽略）。
func Strs(v any) []string {
	arr, _ := v.([]any)
	var out []string
	for _, e := range arr {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// hasPrefixFold 大小写无关的前缀判断。
func hasPrefixFold(s, prefix string) bool {
	return len(s) >= len(prefix) && strings.EqualFold(s[:len(prefix)], prefix)
}
